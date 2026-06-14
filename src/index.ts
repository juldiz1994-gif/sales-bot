import { Telegraf } from 'telegraf'
import { config } from './config'
import { setupBot } from './bot'
import { startTrialCron } from './trial'

const bot = new Telegraf(config.BOT_TOKEN)

setupBot(bot)
startTrialCron(bot)

bot.launch().then(() => {
  console.log('✅ Sales bot жұмыс жасауда...')
})

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
