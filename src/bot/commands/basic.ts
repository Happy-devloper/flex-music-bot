import { GroupModel, MusicQueueModel, UserModel } from '../../models/index.js';
import { isDatabaseConnected } from '../../database/mongoose.js';
import { voiceAssistant } from '../../assistant/voice-assistant.js';
import { InlineKeyboard, type Bot, type Context } from 'grammy';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */
type PlaybackStatus =
  | 'queued'
  | 'playing'
  | 'paused'
  | 'resumed'
  | 'skipped'
  | 'stopped'
  | 'error'
  | 'info';

interface SongMessage {
  chatId: number;
  messageId: number;
  kind: 'text' | 'photo';
  title?: string;
  url?: string;
  durationSeconds?: number;
  requester?: Context['from'];
  status?: PlaybackStatus;
  queueId?: string;
  position?: number;
  startedAt?: number;
}

interface PlaybackPanelPayload {
  chatId: number;
  status: PlaybackStatus;
  title?: string;
  url?: string;
  requester?: Context['from'];
  durationSeconds?: number;
  position?: number;
  queueId?: string;
  message?: string;
  startedAt?: number;
}

/* ------------------------------------------------------------------ */
/*  State & constants                                                  */
/* ------------------------------------------------------------------ */
const queuedSongMessages = new Map<string, SongMessage>();
const playingSongMessages = new Map<number, SongMessage>();

const PROGRESS_INTERVAL_MS = 5_000;          // update every 5 seconds
const TITLE_MAX_LENGTH = 55;
const PROGRESS_BAR_SEGMENTS = 12;

let activeBot: Bot | undefined;
let progressTicker: NodeJS.Timeout | undefined;

/* ------------------------------------------------------------------ */
/*  Command descriptions for /help                                     */
/* ------------------------------------------------------------------ */
const commandDescriptions = [
  { command: 'start', description: 'Start the bot' },
  { command: 'help', description: 'Show available commands' },
  { command: 'ping', description: 'Check bot latency' },
  { command: 'join', description: 'Join the active voice chat' },
  { command: 'leave', description: 'Leave the voice chat' },
  { command: 'play', description: 'Queue a song by name or URL' },
  { command: 'pause', description: 'Pause playback' },
  { command: 'resume', description: 'Resume playback' },
  { command: 'skip', description: 'Skip current song' },
  { command: 'queue', description: 'Show queued songs' },
  { command: 'menu', description: 'Open music controls' },
  { command: 'stats', description: 'Show bot stats' },
] as const;

/* ================================================================== */
/*  MAIN REGISTRATION                                                  */
/* ================================================================== */
export function registerBasicCommands(bot: Bot): void {
  activeBot = bot;
  startProgressTicker();

  // ----- simple commands ------------------------------------------------
  bot.command('start', async (ctx) => {
    const name = ctx.from?.first_name ?? 'there';
    await ctx.reply(
      `Hi ${name}. I am ready to manage music in your Telegram group.\n\nUse /help to see the available commands.`
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(commandDescriptions.map((c) => `/${c.command} - ${c.description}`).join('\n'));
  });

  bot.command('ping', async (ctx) => {
    const start = Date.now();
    const msg = await ctx.reply('Pinging...');
    await ctx.api.editMessageText(msg.chat.id, msg.message_id, `Pong. ${Date.now() - start}ms`);
  });

  bot.command('join', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('/join works inside a Telegram group with an active voice chat.');
      return;
    }
    const result = await voiceAssistant.join(ctx.chat.id);
    await ctx.reply(result.message);
  });

  bot.command('leave', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('/leave works inside a Telegram group.');
      return;
    }
    const result = await voiceAssistant.leave(ctx.chat.id);
    await ctx.reply(result.message);
  });

  // ----- /play ---------------------------------------------------------
  bot.command('play', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('/play works inside a Telegram group with an active voice chat.');
      return;
    }

    const query = ctx.match.trim();
    if (!query) {
      await ctx.reply('Send a song name or URL after /play.');
      return;
    }

    let result: Awaited<ReturnType<typeof voiceAssistant.play>> | undefined;

    try {
      result = await voiceAssistant.play(ctx.chat.id, query);
    } catch (error) {
      await ctx.reply(error instanceof Error ? error.message : 'Could not prepare your song.');
      return;
    }

    await deleteCommandMessage(ctx);

    if (!result?.ok) {
      await ctx.reply(result?.message ?? 'Could not prepare your song.');
      return;
    }

    const payload: PlaybackPanelPayload = {
      chatId: ctx.chat.id,
      status: result.status ?? 'queued',
      title: result.title ?? result.query ?? query,
      url: result.url,                      // actual YouTube URL if available
      requester: ctx.from,
      durationSeconds: result.durationSeconds,
      position: result.position,
      queueId: result.queueId,
      message: result.message,
      startedAt: result.status === 'playing' ? Date.now() : undefined,
    };

    const markup =
      payload.status === 'queued' && payload.queueId
        ? buildQueuePlayNowKeyboard(payload.queueId)
        : buildPlaybackKeyboard(false);

    const sent = await sendPlaybackPanel(bot, undefined, payload, { reply_markup: markup });
    rememberSongMessage(result, {
      chatId: sent.chat.id,
      messageId: sent.message_id,
      kind: sent.photo ? 'photo' : 'text',
      title: payload.title,
      url: payload.url,
      durationSeconds: payload.durationSeconds,
      requester: payload.requester,
      status: payload.status,
      queueId: payload.queueId,
      position: payload.position,
    });
  });

  // ----- /pause --------------------------------------------------------
  bot.command('pause', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('/pause works inside a Telegram group.');
      return;
    }
    const result = await voiceAssistant.pause(ctx.chat.id);
    await deleteCommandMessage(ctx);

    const msg = playingSongMessages.get(ctx.chat.id);
    if (result.ok && msg) {
      await updatePlaybackPanel(
        bot,
        msg,
        {
          chatId: ctx.chat.id,
          status: 'paused',
          title: msg.title,
          url: msg.url,
          requester: msg.requester,
          durationSeconds: msg.durationSeconds,
          queueId: msg.queueId,
          message: result.message,
          startedAt: msg.startedAt,        // keep original startedAt for progress
        },
        { reply_markup: buildPlaybackKeyboard(true) }
      );
      return;
    }
    await ctx.reply(result.message);
  });

  // ----- /resume -------------------------------------------------------
  bot.command('resume', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('/resume works inside a Telegram group.');
      return;
    }
    const result = await voiceAssistant.resume(ctx.chat.id);
    await deleteCommandMessage(ctx);

    const msg = playingSongMessages.get(ctx.chat.id);
    if (result.ok && msg) {
      await updatePlaybackPanel(
        bot,
        msg,
        {
          chatId: ctx.chat.id,
          status: 'resumed',
          title: msg.title,
          url: msg.url,
          requester: msg.requester,
          durationSeconds: msg.durationSeconds,
          queueId: msg.queueId,
          message: result.message,
          startedAt: msg.startedAt,        // preserve original start time
        },
        { reply_markup: buildPlaybackKeyboard(false) }
      );
      return;
    }
    await ctx.reply(result.message);
  });

  // ----- /skip ---------------------------------------------------------
  bot.command('skip', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('/skip works inside a Telegram group.');
      return;
    }
    const result = await voiceAssistant.skip(ctx.chat.id);
    await deleteCommandMessage(ctx);

    const msg = playingSongMessages.get(ctx.chat.id);
    if (result.ok && msg) {
      await updatePlaybackPanel(bot, msg, {
        chatId: ctx.chat.id,
        status: 'skipped',
        title: msg.title,
        url: msg.url,
        requester: msg.requester,
        durationSeconds: msg.durationSeconds,
        queueId: msg.queueId,
        message: result.message,
        startedAt: msg.startedAt,
      });
      return;
    }
    await ctx.reply(result.message);
  });

  // ----- /queue --------------------------------------------------------
  bot.command('queue', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('/queue works inside a Telegram group.');
      return;
    }
    await ctx.reply(await voiceAssistant.getQueue(ctx.chat.id));
  });

  // ----- /menu ---------------------------------------------------------
  bot.command('menu', async (ctx) => {
    await ctx.reply('Use /play to add a song. Playback controls appear in the player message.');
  });

  // ----- /stats --------------------------------------------------------
  bot.command('stats', async (ctx) => {
    const [users, groups, queues] = await Promise.all([
      UserModel.countDocuments(),
      GroupModel.countDocuments({ isActive: true }),
      MusicQueueModel.countDocuments(),
    ]);
    await ctx.reply(
      [
        'Bot stats:',
        `Database: ${isDatabaseConnected() ? 'connected' : 'disconnected'}`,
        `Users: ${users}`,
        `Active groups: ${groups}`,
        `Queues: ${queues}`,
      ].join('\n')
    );
  });

  /* - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     Callback Queries
     - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - */

  bot.callbackQuery('assistant:add', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.chat || (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup')) {
      await ctx.reply('Use this inside the target group.');
      return;
    }
    try {
      const invite = await ctx.createChatInviteLink({ member_limit: 1, name: 'Music assistant setup' });
      const result = await voiceAssistant.joinGroupByInvite(invite.invite_link);
      await ctx.reply(result.message);
    } catch {
      await ctx.reply('Could not create an assistant invite. Make the bot admin with invite-link permission.');
    }
  });

  // Play Now from queue
  bot.callbackQuery(/^music:play-now:(.+)$/, async (ctx) => {
    if (!ctx.chat) return ctx.answerCallbackQuery('Use this inside a group.');
    const queueId = ctx.match[1];
    if (!queueId) return ctx.answerCallbackQuery('That queued song is no longer available.');

    const result = await voiceAssistant.playNow(ctx.chat.id, queueId);
    await ctx.answerCallbackQuery(result.ok ? 'Playing now.' : result.message);
    if (!result.ok || !ctx.callbackQuery.message) return;

    const currentMsg: SongMessage = {
      chatId: ctx.callbackQuery.message.chat.id,
      messageId: ctx.callbackQuery.message.message_id,
      kind: 'text',
    };

    const payload: PlaybackPanelPayload = {
      chatId: currentMsg.chatId,
      status: result.status ?? 'playing',
      title: result.title ?? result.query ?? 'Unknown',
      url: result.url,
      requester: ctx.from,
      durationSeconds: result.durationSeconds,
      queueId: result.queueId,
      message: result.message,
      startedAt: result.status === 'playing' ? Date.now() : undefined,
    };

    await updatePlaybackPanel(bot, currentMsg, payload, { reply_markup: buildPlaybackKeyboard(false) });
    rememberSongMessage(result, {
      chatId: currentMsg.chatId,
      messageId: currentMsg.messageId,
      kind: 'text',
      title: payload.title,
      url: payload.url,
      durationSeconds: payload.durationSeconds,
      requester: payload.requester,
      status: payload.status,
      queueId: payload.queueId,
    });
  });

  // Pause button
  bot.callbackQuery('music:pause', async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = ctx.chat?.id ?? 0;
    const result = await voiceAssistant.pause(chatId);
    const msg = ctx.chat ? playingSongMessages.get(ctx.chat.id) : undefined;
    if (result.ok && msg) {
      await updatePlaybackPanel(bot, msg, {
        chatId: msg.chatId,
        status: 'paused',
        title: msg.title,
        url: msg.url,
        requester: msg.requester,
        durationSeconds: msg.durationSeconds,
        queueId: msg.queueId,
        message: result.message,
        startedAt: msg.startedAt,
      }, { reply_markup: buildPlaybackKeyboard(true) });
      return;
    }
    if (ctx.chat) await ctx.reply(result.message);
  });

  // Resume button
  bot.callbackQuery('music:resume', async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = ctx.chat?.id ?? 0;
    const result = await voiceAssistant.resume(chatId);
    const msg = ctx.chat ? playingSongMessages.get(ctx.chat.id) : undefined;
    if (result.ok && msg) {
      await updatePlaybackPanel(bot, msg, {
        chatId: msg.chatId,
        status: 'resumed',
        title: msg.title,
        url: msg.url,
        requester: msg.requester,
        durationSeconds: msg.durationSeconds,
        queueId: msg.queueId,
        message: result.message,
        startedAt: msg.startedAt,
      }, { reply_markup: buildPlaybackKeyboard(false) });
      return;
    }
    if (ctx.chat) await ctx.reply(result.message);
  });

  // Skip button
  bot.callbackQuery('music:skip', async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = ctx.chat?.id ?? 0;
    const result = await voiceAssistant.skip(chatId);
    const msg = ctx.chat ? playingSongMessages.get(ctx.chat.id) : undefined;
    if (result.ok && msg) {
      await updatePlaybackPanel(bot, msg, {
        chatId: msg.chatId,
        status: 'skipped',
        title: msg.title,
        url: msg.url,
        requester: msg.requester,
        durationSeconds: msg.durationSeconds,
        queueId: msg.queueId,
        message: result.message,
        startedAt: msg.startedAt,
      });
      return;
    }
    if (ctx.chat) await ctx.reply(result.message);
  });

  // Stop button
  bot.callbackQuery('music:stop', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.chat) return;
    const result = await voiceAssistant.leave(ctx.chat.id);
    const msg = playingSongMessages.get(ctx.chat.id);
    if (msg) {
      await updatePlaybackPanel(bot, msg, {
        chatId: msg.chatId,
        status: 'stopped',
        title: msg.title,
        url: msg.url,
        requester: msg.requester,
        durationSeconds: msg.durationSeconds,
        queueId: msg.queueId,
        message: result.message,
        startedAt: msg.startedAt,
      });
    }
    await ctx.reply(result.message);
  });

  // Queue button (displays queue as text)
  bot.callbackQuery('music:queue', async (ctx) => {
    await ctx.answerCallbackQuery('Showing the current queue.');
    if (!ctx.chat) return;
    await ctx.reply(await voiceAssistant.getQueue(ctx.chat.id));
  });

  // Loop button (informative)
  bot.callbackQuery('music:loop', async (ctx) => {
    await ctx.answerCallbackQuery('Loop mode is not available in this build.');
  });

  // Completed button (informative)
  bot.callbackQuery('music:completed', async (ctx) => {
    await ctx.answerCallbackQuery('This song has finished.');
  });

  // Previous button (informative)
  bot.callbackQuery('music:previous', async (ctx) => {
    await ctx.answerCallbackQuery('Previous track is not supported yet.');
  });

  /* - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     Voice assistant events
     - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - */

  voiceAssistant.onTrackStarted((event) => {
    const msg = queuedSongMessages.get(event.queueId);
    if (!msg) return;

    const result = {
      ok: true,
      message: `Playing: ${event.query}`,
      status: 'playing' as const,
      query: event.query,
      title: event.title,
      url: event.url,
      queueId: event.queueId,
      durationSeconds: event.durationSeconds,
      startedAt: Date.now(),
    };

    void updatePlaybackPanel(
      bot,
      msg,
      {
        chatId: msg.chatId,
        status: 'playing',
        title: event.title,
        url: event.url,
        requester: msg.requester,
        durationSeconds: event.durationSeconds,
        queueId: event.queueId,
        message: result.message,
        startedAt: result.startedAt,
      },
      { reply_markup: buildPlaybackKeyboard(false) }
    )
      .then((updated) => rememberSongMessage(result, updated))
      .catch(() => undefined);
  });

  voiceAssistant.onTrackFinished((event) => {
    const msg = playingSongMessages.get(event.chatId);
    if (!msg) return;

    void updatePlaybackPanel(
      bot,
      msg,
      {
        chatId: event.chatId,
        status: 'stopped',
        title: event.title,
        url: event.url,
        requester: msg.requester,
        durationSeconds: event.durationSeconds,
        queueId: msg.queueId,
        message: 'Playback finished.',
        startedAt: msg.startedAt,
      },
      { reply_markup: buildStoppedKeyboard() }
    ).catch(() => undefined);
  });
}

/* ================================================================== */
/*  HELPER: UI MESSAGE BUILDERS (redesigned)                           */
/* ================================================================== */

/**
 * Build the message text based on playback status.
 */
function buildStatusMessage(payload: PlaybackPanelPayload): string {
  switch (payload.status) {
    case 'queued':
      return buildQueueMessage(payload);
    case 'playing':
    case 'resumed':
      return buildNowPlayingMessage(payload);
    case 'paused':
      return buildPausedMessage(payload);
    case 'stopped':
      return buildStoppedMessage(payload);
    case 'skipped':
      return buildSkippedMessage(payload);
    default:
      return buildNowPlayingMessage(payload);
  }
}

function buildNowPlayingMessage(payload: PlaybackPanelPayload): string {
  const title = getLinkedTitle(truncateTitle(payload.title ?? payload.message ?? 'Unknown Track'), payload.url);
  const requester = formatRequester(payload.requester);
  const progressLine = buildProgressLine(payload.durationSeconds, payload.startedAt);
  return [
    '🎵 <b>Started streaming</b>',
    `🎶 <b>Title:</b> ${title}`,
    requester,
    progressLine,
  ].join('\n');
}

function buildPausedMessage(payload: PlaybackPanelPayload): string {
  const title = getLinkedTitle(truncateTitle(payload.title ?? ''), payload.url);
  const requester = formatRequester(payload.requester);
  const progressLine = buildProgressLine(payload.durationSeconds, payload.startedAt);
  return [
    '⏸ <b>Paused</b>',
    `🎶 <b>Title:</b> ${title}`,
    requester,
    progressLine,                    // shows where paused
  ].join('\n');
}

function buildStoppedMessage(payload: PlaybackPanelPayload): string {
  const title = getLinkedTitle(truncateTitle(payload.title ?? ''), payload.url);
  const requester = formatRequester(payload.requester);
  return [
    '⏹ <b>Playback Stopped</b>',
    `🎶 <b>Title:</b> ${title}`,
    requester,
  ].join('\n');
}

function buildSkippedMessage(payload: PlaybackPanelPayload): string {
  const title = getLinkedTitle(truncateTitle(payload.title ?? ''), payload.url);
  const requester = formatRequester(payload.requester);
  return [
    '⏭ <b>Skipped</b>',
    `🎶 <b>Title:</b> ${title}`,
    requester,
  ].join('\n');
}

function buildQueueMessage(payload: PlaybackPanelPayload): string {
  const title = getLinkedTitle(truncateTitle(payload.title ?? payload.message ?? 'Unknown Track'), payload.url);
  const requester = formatRequester(payload.requester);
  const position = payload.position ? `📋 Position: #${payload.position}` : '';
  return [
    '➕ <b>Added to Queue</b>',
    `🎶 <b>Title:</b> ${title}`,
    requester,
    position,
  ].filter(Boolean).join('\n');
}

/* ------------------------------------------------------------------ */
/*  Progress bar + time                                                */
/* ------------------------------------------------------------------ */
function buildProgressLine(
  durationSeconds?: number,
  startedAt?: number
): string {
  if (!durationSeconds || durationSeconds <= 0) {
    return '🕒 --:--';
  }
  const total = durationSeconds;
  const elapsed = startedAt
    ? Math.min(total, Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
    : 0;
  const bar = drawProgressBar(elapsed, total);
  return `🕒 ${formatDuration(elapsed)} / ${formatDuration(total)}\n${bar}`;
}

function drawProgressBar(elapsed: number, total: number): string {
  const ratio = Math.min(1, Math.max(0, elapsed / total));
  const markerIdx = Math.round(ratio * (PROGRESS_BAR_SEGMENTS - 1));
  const filled = '▬'.repeat(markerIdx);
  const empty = '▬'.repeat(PROGRESS_BAR_SEGMENTS - 1 - markerIdx);
  return `${filled}◉${empty}`;
}

/* ------------------------------------------------------------------ */
/*  Title formatting – NO fallback to youtube.com                      */
/* ------------------------------------------------------------------ */
function getLinkedTitle(title: string, url?: string): string {
  const safe = escapeHtml(title);
  if (url && /^https?:\/\//i.test(url)) {
    // Link to the exact video URL
    return `<b><a href="${escapeHtml(url)}">${safe}</a></b>`;
  }
  // No URL → plain bold title, no fake link
  return `<b>${safe}</b>`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function truncateTitle(title: string): string {
  if (title.length <= TITLE_MAX_LENGTH) return title;
  return `${title.slice(0, TITLE_MAX_LENGTH - 3).trimEnd()}...`;
}

/* ------------------------------------------------------------------ */
/*  Requester formatting                                               */
/* ------------------------------------------------------------------ */
function formatRequester(user?: Context['from']): string {
  if (!user) return '🙍🏻 <b>Requested by:</b> Unknown';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || 'Unknown User';
  return `🙍🏻 <b>Requested by:</b> ${escapeHtml(name)}`;
}

/* ------------------------------------------------------------------ */
/*  Keyboards                                                          */
/* ------------------------------------------------------------------ */
function buildPlaybackKeyboard(paused: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text('⏮', 'music:previous')
    .text(paused ? '▶' : '⏸', paused ? 'music:resume' : 'music:pause')
    .text('🔁', 'music:loop')
    .text('⏭', 'music:skip')
    .text('⏹', 'music:stop');
}

function buildStoppedKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('▶ Resume', 'music:resume');
}

function buildQueuePlayNowKeyboard(queueId: string): InlineKeyboard {
  return new InlineKeyboard().text('▶ Play Now', `music:play-now:${queueId}`);
}

function getPlayerReplyMarkup(
  status: PlaybackStatus,
  paused: boolean,
  queueId?: string
): InlineKeyboard | undefined {
  if (status === 'queued' && queueId) return buildQueuePlayNowKeyboard(queueId);
  if (status === 'stopped') return buildStoppedKeyboard();
  if (status === 'skipped') return buildPlaybackKeyboard(false);
  return buildPlaybackKeyboard(paused);
}

/* ------------------------------------------------------------------ */
/*  Message sending & editing                                          */
/* ------------------------------------------------------------------ */
async function sendPlaybackPanel(
  bot: Bot,
  previous: SongMessage | undefined,
  payload: PlaybackPanelPayload,
  options?: { reply_markup?: InlineKeyboard }
): Promise<{ chat: { id: number }; message_id: number; photo?: boolean }> {
  const text = buildStatusMessage(payload);
  const thumb = getThumbnailUrl(payload.url);
  const markup = options?.reply_markup;
  const extras = {
    parse_mode: 'HTML' as const,
    link_preview_options: { is_disabled: true },
  };

  if (previous) {
    try {
      if (previous.kind === 'photo' && thumb) {
        await bot.api.editMessageCaption(previous.chatId, previous.messageId, {
          caption: text,
          ...extras,
          reply_markup: markup,
        });
        return { chat: { id: previous.chatId }, message_id: previous.messageId, photo: true };
      }
      await bot.api.editMessageText(previous.chatId, previous.messageId, text, {
        ...extras,
        reply_markup: markup,
      });
      return { chat: { id: previous.chatId }, message_id: previous.messageId };
    } catch {
      // fall through – send a new message
    }
  }

  if (thumb) {
    try {
      const sent = await bot.api.sendPhoto(payload.chatId, thumb, {
        caption: text,
        ...extras,
        reply_markup: markup,
      });
      return { chat: { id: payload.chatId }, message_id: sent.message_id, photo: true };
    } catch {
      // fall through – send text
    }
  }

  const sent = await bot.api.sendMessage(payload.chatId, text, {
    ...extras,
    reply_markup: markup,
  });
  return { chat: { id: payload.chatId }, message_id: sent.message_id };
}

async function updatePlaybackPanel(
  bot: Bot,
  current: SongMessage,
  payload: PlaybackPanelPayload,
  options?: { reply_markup?: InlineKeyboard }
): Promise<SongMessage> {
  const paused = payload.status === 'paused';
  const markup =
    options?.reply_markup ?? getPlayerReplyMarkup(payload.status, paused, payload.queueId);
  const sent = await sendPlaybackPanel(bot, current, payload, { reply_markup: markup });

  const updated: SongMessage = {
    ...current,
    chatId: sent.chat.id,
    messageId: sent.message_id,
    kind: sent.photo ? 'photo' : 'text',
    title: payload.title ?? current.title,
    url: payload.url ?? current.url,
    durationSeconds: payload.durationSeconds ?? current.durationSeconds,
    requester: payload.requester ?? current.requester,
    status: payload.status,
    queueId: payload.queueId ?? current.queueId,
    position: payload.position ?? current.position,
    startedAt: payload.startedAt ?? current.startedAt,
  };

  // Update state maps
  if (
    payload.status === 'playing' ||
    payload.status === 'paused' ||
    payload.status === 'resumed'
  ) {
    playingSongMessages.set(updated.chatId, updated);
  }
  if (payload.status === 'queued' && payload.queueId) {
    queuedSongMessages.set(payload.queueId, updated);
  }
  if (payload.status === 'playing' && payload.queueId) {
    queuedSongMessages.delete(payload.queueId);
  }

  return updated;
}

function rememberSongMessage(
  result: Awaited<ReturnType<typeof voiceAssistant.play>>,
  msg: SongMessage
): void {
  if (result.status === 'queued' && result.queueId) {
    queuedSongMessages.set(result.queueId, msg);
  }
  if (result.status === 'playing') {
    playingSongMessages.set(msg.chatId, msg);
    if (result.queueId) queuedSongMessages.delete(result.queueId);
  }
}

/* ------------------------------------------------------------------ */
/*  Thumbnail URL                                                      */
/* ------------------------------------------------------------------ */
function getThumbnailUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return match?.[1] ? `https://img.youtube.com/vi/${match[1]}/hqdefault.jpg` : undefined;
}

/* ------------------------------------------------------------------ */
/*  Utility: clear / delete messages                                   */
/* ------------------------------------------------------------------ */
async function clearMessage(ctx: Context, msg: { chat: { id: number }; message_id: number }): Promise<void> {
  try {
    await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
  } catch { /* ignore */ }
}

async function deleteCommandMessage(ctx: Context): Promise<void> {
  try {
    await ctx.deleteMessage();
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/*  Progress ticker                                                    */
/* ------------------------------------------------------------------ */
function startProgressTicker(): void {
  if (progressTicker) return;
  progressTicker = setInterval(() => {
    if (!activeBot) return;
    for (const msg of playingSongMessages.values()) {
      if (!msg.chatId || !msg.messageId || !msg.startedAt) continue;
      if (msg.status !== 'playing' && msg.status !== 'resumed') continue;
      // Re-send the panel to update the progress bar
      void updatePlaybackPanel(
        activeBot,
        msg,
        {
          chatId: msg.chatId,
          status: msg.status,
          title: msg.title,
          url: msg.url,
          requester: msg.requester,
          durationSeconds: msg.durationSeconds,
          queueId: msg.queueId,
          message: msg.title ?? 'Playing',
          startedAt: msg.startedAt,
        },
        { reply_markup: buildPlaybackKeyboard(false) }
      ).catch(() => undefined);
    }
  }, PROGRESS_INTERVAL_MS);
}

/* ------------------------------------------------------------------ */
/*  Escape HTML                                                        */
/* ------------------------------------------------------------------ */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/* ------------------------------------------------------------------ */
/*  Register bot commands (set command list)                           */
/* ------------------------------------------------------------------ */
export async function registerBotCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands([...commandDescriptions]);
}
