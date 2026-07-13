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
}

const queuedSongMessages = new Map<string, SongMessage>();
const playingSongMessages = new Map<number, SongMessage>();

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

    const loadingMessage = await ctx.reply('⏳ Preparing your song...');
    let result: Awaited<ReturnType<typeof voiceAssistant.play>> | undefined;

    try {
      result = await voiceAssistant.play(ctx.chat.id, query);
    } catch (error) {
      await clearLoadingMessage(ctx, loadingMessage);
      await ctx.reply(error instanceof Error ? error.message : 'Could not prepare your song.');
      return;
    } finally {
      await clearLoadingMessage(ctx, loadingMessage);
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
      url: result.url,
      requester: ctx.from,
      durationSeconds: result.durationSeconds,
      position: result.position,
      queueId: result.queueId,
      message: result.message
    };

    const message = await sendPlaybackPanel(bot, undefined, payload, {
      parse_mode: 'HTML',
      reply_markup: result.status === 'queued' && result.queueId ? createPlayNowButton(result.queueId) : buildPlayerKeyboard(false)
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
      });
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
      });
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
      const invite = await ctx.createChatInviteLink({
        member_limit: 1,
        name: 'Music assistant setup'
      });
      const result = await voiceAssistant.joinGroupByInvite(invite.invite_link);
      await ctx.reply(result.message);
    } catch {
      await ctx.reply(
        `Could not create an assistant invite. Make the bot admin with invite-link permission.`
      );
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
      message: result.message
    };
    await updatePlaybackPanel(bot, currentMessage, payload, { reply_markup: buildPlayerKeyboard(false) });
    rememberSongMessage(result, {
      chatId: currentMessage.chatId,
      messageId: currentMessage.messageId,
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
      });
      return;
    }

    if (ctx.chat) {
      await ctx.reply(result.message);
    }
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
      });
      return;
    }

    if (ctx.chat) {
      await ctx.reply(result.message);
    }
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

    if (ctx.chat) {
      await ctx.reply(result.message);
    }
  });

  bot.callbackQuery('music:stop', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.chat) {
      return;
    }

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
    if (!ctx.chat) {
      return;
    }

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
    if (!message) {
      return;
    }

    const result = {
      ok: true,
      message: `Playing: ${event.query}`,
      status: 'playing' as const,
      query: event.query,
      title: event.title,
      url: event.url,
      queueId: event.queueId,
      durationSeconds: event.durationSeconds
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
      { reply_markup: buildPlayerKeyboard(false) }
    )
      .then((updated) => {
        rememberSongMessage(result, updated);
      })
      .catch(() => undefined);
  });

  voiceAssistant.onTrackFinished((event) => {
    const message = playingSongMessages.get(event.chatId);
    if (!message) {
      return;
    }

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
      { reply_markup: undefined }
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

export function createMusicMenu(): InlineKeyboard {
 return new InlineKeyboard()
    .text('Add assistant', 'assistant:add')
    .text('Join VC', 'music:join')
    .row()
    .text('Play', 'music:play_help')
    .text('Pause', 'music:pause')
    .text('Resume', 'music:resume')
    .row()
    .text('Skip', 'music:skip')
    .text('Queue', 'music:queue');
}

export function createPlaybackMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text('⏮️', 'music:skip')     // change later when you implement previous
    .text('⏸️', 'music:pause')
    .text('▶️', 'music:resume')
    .text('🔄', 'music:loop')
    .text('⏭️', 'music:skip')
    .text('⏹️', 'music:stop');
}

function createPlayNowButton(queueId: string): InlineKeyboard {
  return new InlineKeyboard().text('▶', `music:play-now:${queueId}`);
}

function buildPlayerKeyboard(_isPaused: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text('⏮️', 'music:skip')     // change later when you implement previous
    .text('⏸️', 'music:pause')
    .text('▶️', 'music:resume')
    .text('🔄', 'music:loop')
    .text('⏭️', 'music:skip')
    .text('⏹️', 'music:stop');
}

function buildQueueMessage(payload: PlaybackPanelPayload): string {
  const title = getLinkedTitle(
    payload.title ?? payload.message ?? 'Unknown Track',
    payload.url
  );

  return [
    '♪ Added to Queue',
    '',
    `♫ Title: ${title}`,
    `⏱ Duration: ${formatDuration(payload.durationSeconds)} min`,
    `◌ Requested by: ${formatRequester(payload.requester)}`
  ].join('\n');
}

function buildNowPlayingMessage(payload: PlaybackPanelPayload): string {
  const title = getLinkedTitle(
    payload.title ?? payload.message ?? 'Unknown Track',
    payload.url
  );

  const duration = `${formatDuration(payload.durationSeconds)} min`;

  const header =
    payload.status === 'paused'
      ? '⏸ Paused'
      : payload.status === 'resumed'
        ? '▶ Resumed'
        : payload.status === 'skipped'
          ? '⏭ Skipped'
          : payload.status === 'stopped'
            ? '■ Playback Finished'
            : '♫ Started streaming';

  return [
    header,
    '',
    `♫ Title: ${title}`,
    `⏱ Duration: ${duration}`,
    `◌ Requested by: ${formatRequester(payload.requester)}`
  ].join('\n');
}
function getLinkedTitle(title: string, url?: string): string {
  const safeTitle = escapeHtml(title);
  const resolvedUrl = getYoutubeLink(title, url);
  return `<a href="${escapeHtml(resolvedUrl)}">${safeTitle}</a>`;
}

function getYoutubeLink(title: string, url?: string): string {
  if (url && /https?:\/\//i.test(url)) {
    return url;
  }

  const query = encodeURIComponent(title);
  return `https://www.youtube.com/results?search_query=${query}`;
}

async function sendPlaybackPanel(
  bot: Bot,
  previousMessage: SongMessage | undefined,
  payload: PlaybackPanelPayload,
  options?: { parse_mode?: 'HTML'; reply_markup?: InlineKeyboard }
): Promise<{ chat: { id: number }; message_id: number; photo?: boolean }> {
  const text = payload.status === 'queued' ? buildQueueMessage(payload) : buildNowPlayingMessage(payload);
  const thumbnailUrl = getThumbnailUrl(payload.url);
  const replyMarkup = options?.reply_markup;

  if (previousMessage) {
    try {
      if (previousMessage.kind === 'photo' && thumbnailUrl) {
        await bot.api.editMessageCaption(previousMessage.chatId, previousMessage.messageId, {
          caption: text,
          parse_mode: 'HTML',
          reply_markup: replyMarkup
        });
        return { chat: { id: previousMessage.chatId }, message_id: previousMessage.messageId, photo: true };
      }

      await bot.api.editMessageText(previousMessage.chatId, previousMessage.messageId, text, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      });
      return { chat: { id: previousMessage.chatId }, message_id: previousMessage.messageId };
    } catch {
      // Fall back to a fresh message when the old one is no longer available.
    }
  }

  if (thumbnailUrl) {
    try {
      const message = await bot.api.sendPhoto(payload.chatId, thumbnailUrl, {
        caption: text,
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      });
      return { chat: { id: payload.chatId }, message_id: message.message_id, photo: true };
    } catch {
      // Fall back to a simple text message if the thumbnail cannot be sent.
    }
  }

  const message = await bot.api.sendMessage(payload.chatId, text, {
    parse_mode: 'HTML',
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
    parse_mode: 'HTML',
    reply_markup: options?.reply_markup
  });

  const updatedMessage: SongMessage = {
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
    position: payload.position ?? currentMessage.position
  };

  if (payload.status === 'playing' || payload.status === 'paused' || payload.status === 'resumed') {
    playingSongMessages.set(updatedMessage.chatId, updatedMessage);
  }

  if (payload.status === 'queued' && payload.queueId) {
    queuedSongMessages.set(payload.queueId, updatedMessage);
  }

  if (payload.status === 'playing' && payload.queueId) {
    queuedSongMessages.delete(payload.queueId);
  }

  return updatedMessage;
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
    if (result.queueId) {
      queuedSongMessages.delete(result.queueId);
    }
  }
}

function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) {
    return '--:--';
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

async function clearLoadingMessage(ctx: Context, loadingMessage: { chat: { id: number }; message_id: number }): Promise<void> {
  try {
    await ctx.api.deleteMessage(loadingMessage.chat.id, loadingMessage.message_id);
  } catch {
    // Ignore if the loading message is already gone.
  }
}

async function deleteCommandMessage(ctx: Context): Promise<void> {
  try {
    await ctx.deleteMessage();
  } catch {
    // The bot can only delete user commands when it has delete-message permission.
  }
}

function formatRequester(user?: Context['from']): string {
  if (!user) {
    return 'Unknown';
  }

  const fullName = [user.first_name, user.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();

  return escapeHtml(fullName || user.username || 'Unknown');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function getThumbnailUrl(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }

  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (!match?.[1]) {
    return undefined;
  }

  return `https://img.youtube.com/vi/${match[1]}/hqdefault.jpg`;
}

export async function registerBotCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands([...commandDescriptions]);
}
