import { GroupModel, MusicQueueModel, UserModel } from '../../models/index.js';
import { isDatabaseConnected } from '../../database/mongoose.js';
import { voiceAssistant } from '../../assistant/voice-assistant.js';
import { InlineKeyboard, type Bot, type Context } from 'grammy';

interface SongMessage {
  chatId: number;
  messageId: number;
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

    const result = await voiceAssistant.play(ctx.chat.id, query);
    await deleteCommandMessage(ctx);
    const message = await ctx.reply(formatPlayPanel(result, query, ctx.from), {
      parse_mode: 'HTML',
      reply_markup: result.status === 'queued' && result.queueId ? createPlayNowButton(result.queueId) : undefined
    });
    rememberSongMessage(result, { chatId: message.chat.id, messageId: message.message_id });
  });

  bot.command('pause', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('/pause works inside a Telegram group.');
      return;
    }

    await ctx.reply((await voiceAssistant.pause(ctx.chat.id)).message);
  });

  bot.command('resume', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('/resume works inside a Telegram group.');
      return;
    }

    await ctx.reply((await voiceAssistant.resume(ctx.chat.id)).message);
  });

  bot.command('skip', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('/skip works inside a Telegram group.');
      return;
    }

    await ctx.reply((await voiceAssistant.skip(ctx.chat.id)).message);
  });

  bot.command('queue', async (ctx) => {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('/queue works inside a Telegram group.');
      return;
    }

    await ctx.reply(await voiceAssistant.getQueue(ctx.chat.id));
  });

  bot.command('menu', async (ctx) => {
    await ctx.reply('Use /play to add a song. Queued songs have a Play Now button.');
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

    const message = {
      chatId: ctx.callbackQuery.message.chat.id,
      messageId: ctx.callbackQuery.message.message_id
    };
    await ctx.api.editMessageText(
      message.chatId,
      message.messageId,
      formatPlayPanel(result, result.query ?? 'Unknown', ctx.from),
      { parse_mode: 'HTML' }
    );
    rememberSongMessage(result, message);
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
    void bot.api
      .editMessageText(message.chatId, message.messageId, formatPlayPanel(result, event.query), {
        parse_mode: 'HTML'
      })
      .then(() => rememberSongMessage(result, message))
      .catch(() => undefined);
  });

  voiceAssistant.onTrackFinished((event) => {
    const message = playingSongMessages.get(event.chatId);
    if (!message) {
      return;
    }

    void bot.api
      .editMessageReplyMarkup(message.chatId, message.messageId, {
        reply_markup: createCompletedButton()
      })
      .catch(() => undefined);
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
    .text('▷', 'music:previous')
    .text('Ⅱ', 'music:pause')
    .text('↻', 'music:resume')
    .text('▷Ⅱ', 'music:skip')
    .text('□', 'music:stop')
    .row()
    .text('Queue', 'music:queue')
    .text('Menu', 'music:play_help');
}

function createPlayNowButton(queueId: string): InlineKeyboard {
  return new InlineKeyboard().text('Play Now', `music:play-now:${queueId}`);
}

function createCompletedButton(): InlineKeyboard {
  return new InlineKeyboard().text('──────────── ●', 'music:completed');
}

function formatPlayPanel(
  result: Awaited<ReturnType<typeof voiceAssistant.play>>,
  fallbackQuery: string,
  requester?: Context['from']
): string {
  const rawTitle = result.title ?? result.query ?? fallbackQuery;
  const title = result.url
    ? `<a href="${escapeHtml(result.url)}">${escapeHtml(rawTitle)}</a>`
    : escapeHtml(rawTitle);
  const requestedBy = formatRequester(requester);

  if (result.status === 'playing') {
    return [
      '♫ <b>Started streaming</b>',
      '',
      `▷ <b>Title:</b> ${title}`,
      `◷ <b>Duration:</b> ${formatDuration(result.durationSeconds)} min`,
      `♧ <b>Requested by:</b> ${requestedBy}`
    ].join('\n');
  }

  if (result.status === 'queued') {
    return [
      '♫ <b>Added to queue</b>',
      '',
      `▷ <b>Title:</b> ${title}`,
      `⌁ <b>Position:</b> ${result.position ?? '-'}`,
      `♧ <b>Requested by:</b> ${requestedBy}`
    ].join('\n');
  }

  return escapeHtml(result.message);
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
  if (!seconds) {
    return 'Unknown';
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
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

  const name = escapeHtml(user.first_name);
  return `<a href="tg://user?id=${user.id}">${name}</a>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export async function registerBotCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands([...commandDescriptions]);
}
