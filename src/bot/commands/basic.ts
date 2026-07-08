import { GroupModel, MusicQueueModel, UserModel } from '../../models/index.js';
import { isDatabaseConnected } from '../../database/mongoose.js';
import { voiceAssistant } from '../../assistant/voice-assistant.js';
import { InlineKeyboard, type Bot, type Context } from 'grammy';

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
    await ctx.reply(formatPlayPanel(result, query), {
      reply_markup: createPlaybackMenu()
    });
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
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('/menu works inside a Telegram group.');
      return;
    }

    await ctx.reply('Music controls:', {
      reply_markup: createMusicMenu()
    });
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

  bot.callbackQuery('music:join', async (ctx) => {
    await ctx.answerCallbackQuery();

    if (!ctx.chat || (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup')) {
      await ctx.reply('Use this inside a group.');
      return;
    }

    await ctx.reply((await voiceAssistant.join(ctx.chat.id)).message);
  });

  bot.callbackQuery('music:pause', async (ctx) => {
    await ctx.answerCallbackQuery();

    if (ctx.chat) {
      await ctx.reply((await voiceAssistant.pause(ctx.chat.id)).message);
    }
  });

  bot.callbackQuery('music:resume', async (ctx) => {
    await ctx.answerCallbackQuery();

    if (ctx.chat) {
      await ctx.reply((await voiceAssistant.resume(ctx.chat.id)).message);
    }
  });

  bot.callbackQuery('music:skip', async (ctx) => {
    await ctx.answerCallbackQuery();

    if (ctx.chat) {
      await ctx.reply((await voiceAssistant.skip(ctx.chat.id)).message);
    }
  });

  bot.callbackQuery('music:previous', async (ctx) => {
    await ctx.answerCallbackQuery('Previous track is not available yet.');
  });

  bot.callbackQuery('music:queue', async (ctx) => {
    await ctx.answerCallbackQuery();

    if (ctx.chat) {
      await ctx.reply(await voiceAssistant.getQueue(ctx.chat.id));
    }
  });

  bot.callbackQuery('music:play_help', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('Send /play followed by a song name or YouTube URL.');
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

function createMusicMenu(): InlineKeyboard {
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

function createPlaybackMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Previous', 'music:previous')
    .text('Pause', 'music:pause')
    .text('Skip', 'music:skip')
    .row()
    .text('Resume', 'music:resume')
    .text('Queue', 'music:queue')
    .text('Menu', 'music:play_help');
}

function formatPlayPanel(
  result: Awaited<ReturnType<typeof voiceAssistant.play>>,
  fallbackQuery: string
): string {
  if (result.status === 'playing') {
    return [
      'Now playing:',
      result.query ?? fallbackQuery,
      `Runtime: ${formatDuration(result.durationSeconds)}`
    ].join('\n');
  }

  if (result.status === 'queued') {
    return [
      'Queued:',
      result.query ?? fallbackQuery,
      `Position: ${result.position ?? '-'}`,
      'It is downloading in the background.'
    ].join('\n');
  }

  return result.message;
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

export async function registerBotCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands([...commandDescriptions]);
}
