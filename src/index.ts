import { Telegraf } from 'telegraf'
import { config } from './config'
import { setupBot } from './bot'
import { startTrialCron } from './trial'
import { initStore } from './store'

async function main() {
  await initStore()

  const bot = new Telegraf(config.BOT_TOKEN)
  setupBot(bot)
  startTrialCron(bot)

  await bot.launch()
  console.log('✅ Sales bot жұмыс жасауда...')
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})

process.once('SIGINT', () => process.exit(0))
process.once('SIGTERM', () => process.exit(0))
