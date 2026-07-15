import { GroupModel, MusicQueueModel, UserModel } from '../../models/index.js';
import { isDatabaseConnected } from '../../database/mongoose.js';
import { voiceAssistant } from '../../assistant/voice-assistant.js';
import { InlineKeyboard, type Bot, type Context } from 'grammy';

type PlaybackStatus = 'queued' | 'playing' | 'paused' | 'resumed' | 'skipped' | 'stopped' | 'error' | 'info';

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

const queuedSongMessages = new Map<string, SongMessage>();
const playingSongMessages = new Map<number, SongMessage>();

const PROGRESS_INTERVAL_MS = 10000;
const TITLE_MAX_LENGTH = 55;
let activeBot: Bot | undefined;
let progressTicker: NodeJS.Timeout | undefined;

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
  { command: 'stats', description: 'Show bot stats' }
] as const;

export function registerBasicCommands(bot: Bot): void {
  activeBot = bot;
  startProgressTicker();

  bot.command('start', async (ctx) => {
    const name = ctx.from?.first_name ?? 'there';
    await ctx.reply(
      `Hi ${name}. I am ready to manage music in your Telegram group.\n\nUse /help to see the available commands.`
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      [
        'Available commands:',
        '/start - Start the bot',
        '/help - Show this help message',
        '/ping - Check bot latency',
        '/join - Ask the assistant account to join the active voice chat',
        '/leave - Ask the assistant account to leave the voice chat',
        '/play <song name or URL> - Queue a track',
        '/pause - Pause playback',
        '/resume - Resume playback',
        '/skip - Skip current song',
        '/queue - Show queued songs',
        '/menu - Open music controls',
        '/stats - Show bot stats'
      ].join('\n')
    );
  });

  bot.command('ping', async (ctx) => {
    const startedAt = Date.now();
    const message = await ctx.reply('Pinging...');
    const latencyMs = Date.now() - startedAt;

    await ctx.api.editMessageText(message.chat.id, message.message_id, `Pong. ${latencyMs}ms`);
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

    const loadingMessage = await ctx.reply('🔍 Searching...');
    let result: Awaited<ReturnType<typeof voiceAssistant.play>> | undefined;

    try {
      result = await voiceAssistant.play(ctx.chat.id, query);
    } catch (error) {
      await clearMessage(ctx, loadingMessage);
      await ctx.reply(error instanceof Error ? error.message : 'Could not prepare your song.');
      return;
    } finally {
      await clearMessage(ctx, loadingMessage);
    }

    await deleteCommandMessage(ctx);

    if (!result?.ok) {
      await ctx.reply(result?.message ?? 'Could not prepare your song.');
      return;
    }

    // Show a compact user request banner before the playback panel
    await sendUserRequestBanner(ctx, query);

    const payload: PlaybackPanelPayload = {
      chatId: ctx.chat.id,
      status: result.status ?? 'queued',
      title: result.title ?? result.query ?? query,
      url: result.url,
      requester: ctx.from,
      durationSeconds: result.durationSeconds,
      position: result.position,
      queueId: result.queueId,
      message: result.message,
      startedAt: result.status === 'playing' ? Date.now() : undefined
    };

    const message = await sendPlaybackPanel(bot, undefined, payload, {
      reply_markup: payload.status === 'queued' && payload.queueId
        ? buildQueuePlayNowKeyboard(payload.queueId)
        : buildPlaybackKeyboard(false)
    });

    rememberSongMessage(result, {
      chatId: message.chat.id,
      messageId: message.message_id,
      kind: message.photo ? 'photo' : 'text',
      title: payload.title,
      url: payload.url,
      durationSeconds: payload.durationSeconds,
      requester: payload.requester,
      status: payload.status,
      queueId: payload.queueId,
      position: payload.position
    });
  });

  bot.command('pause', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('/pause works inside a Telegram group.');
      return;
    }

    const result = await voiceAssistant.pause(ctx.chat.id);
    await deleteCommandMessage(ctx);

    const message = playingSongMessages.get(ctx.chat.id);
    if (result.ok && message) {
      await updatePlaybackPanel(bot, message, {
        chatId: ctx.chat.id,
        status: 'paused',
        title: message.title,
        url: message.url,
        requester: message.requester,
        durationSeconds: message.durationSeconds,
        queueId: message.queueId,
        message: result.message
      }, { reply_markup: buildPlaybackKeyboard(true) });
      return;
    }

    await ctx.reply(result.message);
  });

  bot.command('resume', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('/resume works inside a Telegram group.');
      return;
    }

    const result = await voiceAssistant.resume(ctx.chat.id);
    await deleteCommandMessage(ctx);

    const message = playingSongMessages.get(ctx.chat.id);
    if (result.ok && message) {
      await updatePlaybackPanel(bot, message, {
        chatId: ctx.chat.id,
        status: 'resumed',
        title: message.title,
        url: message.url,
        requester: message.requester,
        durationSeconds: message.durationSeconds,
        queueId: message.queueId,
        message: result.message
      }, { reply_markup: buildPlaybackKeyboard(false) });
      return;
    }

    await ctx.reply(result.message);
  });

  bot.command('skip', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('/skip works inside a Telegram group.');
      return;
    }

    const result = await voiceAssistant.skip(ctx.chat.id);
    await deleteCommandMessage(ctx);

    const message = playingSongMessages.get(ctx.chat.id);
    if (result.ok && message) {
      await updatePlaybackPanel(bot, message, {
        chatId: ctx.chat.id,
        status: 'skipped',
        title: message.title,
        url: message.url,
        requester: message.requester,
        durationSeconds: message.durationSeconds,
        queueId: message.queueId,
        message: result.message
      });
      return;
    }

    await ctx.reply(result.message);
  });

  bot.command('queue', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('/queue works inside a Telegram group.');
      return;
    }

    await ctx.reply(await voiceAssistant.getQueue(ctx.chat.id));
  });

  bot.command('menu', async (ctx) => {
    await ctx.reply('Use /play to add a song. Playback controls appear in the player message.');
  });

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

  bot.callbackQuery(/^music:play-now:(.+)$/, async (ctx) => {
    if (!ctx.chat) {
      await ctx.answerCallbackQuery('Use this inside a group.');
      return;
    }

    const queueId = ctx.match[1];
    if (!queueId) {
      await ctx.answerCallbackQuery('That queued song is no longer available.');
      return;
    }

    const result = await voiceAssistant.playNow(ctx.chat.id, queueId);
    await ctx.answerCallbackQuery(result.ok ? 'Playing now.' : result.message);

    if (!result.ok || !ctx.callbackQuery.message) {
      return;
    }

    const currentMessage = {
      chatId: ctx.callbackQuery.message.chat.id,
      messageId: ctx.callbackQuery.message.message_id,
      kind: 'text' as const
    };
    const payload: PlaybackPanelPayload = {
      chatId: currentMessage.chatId,
      status: result.status ?? 'playing',
      title: result.title ?? result.query ?? 'Unknown',
      url: result.url,
      requester: ctx.from,
      durationSeconds: result.durationSeconds,
      queueId: result.queueId,
      message: result.message,
      startedAt: result.status === 'playing' ? Date.now() : undefined
    };
    await updatePlaybackPanel(bot, currentMessage, payload, { reply_markup: buildPlaybackKeyboard(false) });
    rememberSongMessage(result, {
      chatId: currentMessage.chatId,
      messageId: currentMessage.messageId, // corrected
      kind: 'text',
      title: payload.title,
      url: payload.url,
      durationSeconds: payload.durationSeconds,
      requester: payload.requester,
      status: payload.status,
      queueId: payload.queueId
    });
  });
  bot.callbackQuery('music:pause', async (ctx) => {
    await ctx.answerCallbackQuery();
    const result = await voiceAssistant.pause(ctx.chat?.id ?? 0);
    const message = ctx.chat ? playingSongMessages.get(ctx.chat.id) : undefined;
    if (result.ok && message) {
      await updatePlaybackPanel(bot, message, {
        chatId: message.chatId,
        status: 'paused',
        title: message.title,
        url: message.url,
        requester: message.requester,
        durationSeconds: message.durationSeconds,
        queueId: message.queueId,
        message: result.message
      }, { reply_markup: buildPlaybackKeyboard(true) });
      return;
    }
    if (ctx.chat) await ctx.reply(result.message);
  });

  bot.callbackQuery('music:resume', async (ctx) => {
    await ctx.answerCallbackQuery();
    const result = await voiceAssistant.resume(ctx.chat?.id ?? 0);
    const message = ctx.chat ? playingSongMessages.get(ctx.chat.id) : undefined;
    if (result.ok && message) {
      await updatePlaybackPanel(bot, message, {
        chatId: message.chatId,
        status: 'resumed',
        title: message.title,
        url: message.url,
        requester: message.requester,
        durationSeconds: message.durationSeconds,
        queueId: message.queueId,
        message: result.message
      }, { reply_markup: buildPlaybackKeyboard(false) });
      return;
    }
    if (ctx.chat) await ctx.reply(result.message);
  });

  bot.callbackQuery('music:skip', async (ctx) => {
    await ctx.answerCallbackQuery();
    const result = await voiceAssistant.skip(ctx.chat?.id ?? 0);
    const message = ctx.chat ? playingSongMessages.get(ctx.chat.id) : undefined;
    if (result.ok && message) {
      await updatePlaybackPanel(bot, message, {
        chatId: message.chatId,
        status: 'skipped',
        title: message.title,
        url: message.url,
        requester: message.requester,
        durationSeconds: message.durationSeconds,
        queueId: message.queueId,
        message: result.message
      });
      return;
    }
    if (ctx.chat) await ctx.reply(result.message);
  });

  bot.callbackQuery('music:stop', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.chat) return;
    const result = await voiceAssistant.leave(ctx.chat.id);
    const message = playingSongMessages.get(ctx.chat.id);
    if (message) {
      await updatePlaybackPanel(bot, message, {
        chatId: message.chatId,
        status: 'stopped',
        title: message.title,
        url: message.url,
        requester: message.requester,
        durationSeconds: message.durationSeconds,
        queueId: message.queueId,
        message: result.message
      });
    }
    await ctx.reply(result.message);
  });

  bot.callbackQuery('music:queue', async (ctx) => {
    await ctx.answerCallbackQuery('Showing the current queue.');
    if (!ctx.chat) return;
    const queueText = await voiceAssistant.getQueue(ctx.chat.id);
    await ctx.reply(queueText);
  });

  bot.callbackQuery('music:loop', async (ctx) => {
    await ctx.answerCallbackQuery('Loop mode is not available in this build.');
  });

  bot.callbackQuery('music:completed', async (ctx) => {
    await ctx.answerCallbackQuery('This song has finished.');
  });

  voiceAssistant.onTrackStarted((event) => {
    const message = queuedSongMessages.get(event.queueId);
    if (!message) return;

    const result = {
      ok: true,
      message: `Playing: ${event.query}`,
      status: 'playing' as const,
      query: event.query,
      title: event.title,
      url: event.url,
      queueId: event.queueId,
      durationSeconds: event.durationSeconds,
      startedAt: Date.now()
    };

    void updatePlaybackPanel(
      bot,
      message,
      {
        chatId: message.chatId,
        status: 'playing',
        title: event.title,
        url: event.url,
        requester: message.requester,
        durationSeconds: event.durationSeconds,
        queueId: event.queueId,
        message: result.message
      },
      { reply_markup: buildPlaybackKeyboard(false) }
    )
      .then((updated) => {
        rememberSongMessage(result, updated);
      })
      .catch(() => undefined);
  });

  voiceAssistant.onTrackFinished((event) => {
    const message = playingSongMessages.get(event.chatId);
    if (!message) return;

    void updatePlaybackPanel(
      bot,
      message,
      {
        chatId: event.chatId,
        status: 'stopped',
        title: event.title,
        url: event.url,
        requester: message.requester,
        durationSeconds: event.durationSeconds,
        queueId: message.queueId,
        message: 'Playback finished.'
      },
      { reply_markup: buildStoppedKeyboard() }
    ).catch(() => undefined);
  });

  bot.command('stats', async (ctx) => {
    const [users, groups, queues] = await Promise.all([
      UserModel.countDocuments(),
      GroupModel.countDocuments({ isActive: true }),
      MusicQueueModel.countDocuments()
    ]);
    await ctx.reply(
      [
        'Bot stats:',
        `Database: ${isDatabaseConnected() ? 'connected' : 'disconnected'}`,
        `Users: ${users}`,
        `Active groups: ${groups}`,
        `Queues: ${queues}`
      ].join('\n')
    );
  });
}

/* ---------- UI HELPER FUNCTIONS ---------- */

/**
 * Compact user request banner (shown right before the playback panel)
 */
async function sendUserRequestBanner(ctx: Context, query: string): Promise<void> {
  const user = ctx.from;
  if (!user) return;
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || 'User';
  const banner = `👤 <b>${escapeHtml(displayName)}</b>\n<code>/play ${escapeHtml(query)}</code>`;
  await ctx.reply(banner, { parse_mode: 'HTML' });
}

/**
 * Build the now‑playing message following the Resso layout.
 */
function buildNowPlayingMessage(payload: PlaybackPanelPayload): string {
  const statusLine = getStatusText(payload.status);
  const titleLine = `▶ Title: ${getLinkedTitle(truncateTitle(payload.title ?? payload.message ?? 'Unknown Track'), payload.url)}`;
  const durationLine = `⏱ Duration: ${formatDuration(payload.durationSeconds ?? 0)} min`;
  const requesterLine = `👤 Requested by: ${formatRequesterName(payload.requester)}`;

  const lines: string[] = [statusLine, titleLine, durationLine, requesterLine];

  if (payload.startedAt && payload.durationSeconds && payload.durationSeconds > 0) {
    const elapsed = Math.min(payload.durationSeconds, Math.max(0, Math.floor((Date.now() - payload.startedAt) / 1000)));
    lines.push(buildProgressBar(payload.durationSeconds, elapsed));
    lines.push(`${formatDuration(elapsed)} / ${formatDuration(payload.durationSeconds)}`);
  }

  return lines.join('\n');
}

/**
 * Build the queued song message.
 */
function buildQueueMessage(payload: PlaybackPanelPayload): string {
  const titleLine = `🎶 ${getLinkedTitle(truncateTitle(payload.title ?? payload.message ?? 'Unknown Track'), payload.url)}`;
  const durationLine = `⏱ Duration: ${formatDuration(payload.durationSeconds ?? 0)} min`;
  const requesterLine = `👤 Requested by: ${formatRequesterName(payload.requester)}`;
  const positionLine = payload.position ? `Queue Position · #${payload.position}` : '';

  const lines: string[] = [
    '➕ Added to Queue',
    titleLine,
    durationLine,
    requesterLine,
    positionLine,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'  // separator line
  ].filter(Boolean);

  return lines.join('\n');
}

function getStatusText(status?: PlaybackStatus): string {
  switch (status) {
    case 'paused': return '⏸ Paused';
    case 'resumed': return '▶ Resumed';
    case 'skipped': return '⏭ Skipped';
    case 'stopped': return '⏹ Stopped';
    case 'playing': return '🎵 Started Streaming';
    default: return '🎵 Started Streaming';
  }
}

function getLinkedTitle(title: string, url?: string): string {
  const safeTitle = escapeHtml(title);
  const resolvedUrl = url && /^https?:\/\//i.test(url) ? url : 'https://www.youtube.com/';
  return `<b><a href="${escapeHtml(resolvedUrl)}">${safeTitle}</a></b>`;
}

function buildProgressBar(totalSeconds: number, elapsedSeconds: number): string {
  const totalSegments = 15;
  const ratio = Math.min(1, Math.max(0, elapsedSeconds / totalSeconds));
  const filled = Math.round(ratio * totalSegments);
  const empty = totalSegments - filled;
  return `━━${'━'.repeat(filled)}●${'━'.repeat(empty)}━━`;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatRequesterName(user?: Context['from']): string {
  if (!user) return 'Unknown User';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || 'Unknown User';
  return escapeHtml(name);
}

function truncateTitle(title: string): string {
  if (title.length <= TITLE_MAX_LENGTH) return title;
  return `${title.slice(0, TITLE_MAX_LENGTH - 3).trimEnd()}...`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/* ---------- INLINE KEYBOARDS ---------- */

function buildPlaybackKeyboard(paused: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  keyboard.text('⏮', 'music:previous');
  if (paused) {
    keyboard.text('▶', 'music:resume');
  } else {
    keyboard.text('⏸', 'music:pause');
  }
  keyboard.text('🔄', 'music:loop').text('⏭', 'music:skip').text('⏹', 'music:stop');
  return keyboard;
}

function buildStoppedKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('▶ Play Again', 'music:resume');
}

function buildQueuePlayNowKeyboard(queueId: string): InlineKeyboard {
  return new InlineKeyboard().text('▶ Play Now', `music:play-now:${queueId}`);
}

function getPlayerReplyMarkup(status: PlaybackStatus, queueId?: string): InlineKeyboard | undefined {
  if (status === 'queued' && queueId) {
    return buildQueuePlayNowKeyboard(queueId);
  }
  if (status === 'stopped') {
    return buildStoppedKeyboard();
  }
  return buildPlaybackKeyboard(status === 'paused');
}

/* ---------- MESSAGE SENDING & EDITING ---------- */

async function sendPlaybackPanel(
  bot: Bot,
  previousMessage: SongMessage | undefined,
  payload: PlaybackPanelPayload,
  options?: { reply_markup?: InlineKeyboard }
): Promise<{ chat: { id: number }; message_id: number; photo?: boolean }> {
  const text = payload.status === 'queued' ? buildQueueMessage(payload) : buildNowPlayingMessage(payload);
  const thumbnailUrl = getThumbnailUrl(payload.url);
  const replyMarkup = options?.reply_markup;
  const baseExtra = {
    parse_mode: 'HTML' as const,
    link_preview_options: { is_disabled: true }
  };

  if (previousMessage) {
    try {
      if (previousMessage.kind === 'photo' && thumbnailUrl) {
        await bot.api.editMessageCaption(previousMessage.chatId, previousMessage.messageId, {
          caption: text,
          ...baseExtra,
          reply_markup: replyMarkup
        });
        return { chat: { id: previousMessage.chatId }, message_id: previousMessage.messageId, photo: true };
      }
      await bot.api.editMessageText(previousMessage.chatId, previousMessage.messageId, text, {
        ...baseExtra,
        reply_markup: replyMarkup
      });
      return { chat: { id: previousMessage.chatId }, message_id: previousMessage.messageId };
    } catch {
      // fallback to new message
    }
  }

  if (thumbnailUrl) {
    try {
      const message = await bot.api.sendPhoto(payload.chatId, thumbnailUrl, {
        caption: text,
        ...baseExtra,
        reply_markup: replyMarkup
      });
      return { chat: { id: payload.chatId }, message_id: message.message_id, photo: true };
    } catch {
      // fallback to text
    }
  }

  const message = await bot.api.sendMessage(payload.chatId, text, {
    ...baseExtra,
    reply_markup: replyMarkup
  });
  return { chat: { id: payload.chatId }, message_id: message.message_id };
}

async function updatePlaybackPanel(
  bot: Bot,
  currentMessage: SongMessage,
  payload: PlaybackPanelPayload,
  options?: { reply_markup?: InlineKeyboard }
): Promise<SongMessage> {
  const nextMessage = await sendPlaybackPanel(bot, currentMessage, payload, {
    reply_markup: options?.reply_markup ?? getPlayerReplyMarkup(payload.status, payload.queueId)
  });

  const updated: SongMessage = {
    ...currentMessage,
    chatId: nextMessage.chat.id,
    messageId: nextMessage.message_id,
    kind: nextMessage.photo ? 'photo' : 'text',
    title: payload.title ?? currentMessage.title,
    url: payload.url ?? currentMessage.url,
    durationSeconds: payload.durationSeconds ?? currentMessage.durationSeconds,
    requester: payload.requester ?? currentMessage.requester,
    status: payload.status,
    queueId: payload.queueId ?? currentMessage.queueId,
    position: payload.position ?? currentMessage.position,
    startedAt: payload.startedAt ?? currentMessage.startedAt
  };

  // keep track of which message is the active player
  if (payload.status === 'playing' || payload.status === 'paused' || payload.status === 'resumed') {
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
  message: SongMessage
): void {
  if (result.status === 'queued' && result.queueId) {
    queuedSongMessages.set(result.queueId, message);
  }
  if (result.status === 'playing') {
    playingSongMessages.set(message.chatId, message);
    if (result.queueId) queuedSongMessages.delete(result.queueId);
  }
}

function getThumbnailUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return match?.[1] ? `https://img.youtube.com/vi/${match[1]}/hqdefault.jpg` : undefined;
}

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

/* ---------- PROGRESS TICKER ---------- */

function startProgressTicker(): void {
  if (progressTicker) return;
  progressTicker = setInterval(() => {
    if (!activeBot) return;
    for (const message of playingSongMessages.values()) {
      if (!message.chatId || !message.messageId || !message.startedAt) continue;
      if (message.status !== 'playing' && message.status !== 'resumed') continue;
      void updatePlaybackPanel(activeBot, message, {
        chatId: message.chatId,
        status: message.status,
        title: message.title,
        url: message.url,
        requester: message.requester,
        durationSeconds: message.durationSeconds,
        queueId: message.queueId,
        message: message.title ?? 'Playing',
        startedAt: message.startedAt
      }, { reply_markup: buildPlaybackKeyboard(false) }).catch(() => undefined);
    }
  }, PROGRESS_INTERVAL_MS);
}

export async function registerBotCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands([...commandDescriptions]);
}
