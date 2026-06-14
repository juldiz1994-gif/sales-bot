import cron from 'node-cron'
import type { Telegraf } from 'telegraf'
import { Markup } from 'telegraf'
import { getAllClients, updateClient } from './store'
import { suspendTenant } from './platform'
import { t } from './i18n'
import { config } from './config'

function daysPassed(isoDate: string): number {
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86_400_000)
}

export function startTrialCron(bot: Telegraf) {
  // Күн сайын сағат 09:00 Алматы уақытымен (UTC+5 = 04:00 UTC)
  cron.schedule('0 4 * * *', async () => {
    const clients = getAllClients()

    for (const client of clients) {
      // Тегін мерзімді тексеру
      if (client.status === 'trial' && client.trialStartDate) {
        const passed = daysPassed(client.trialStartDate)
        const left = config.TRIAL_DAYS - passed

        if (left === 1 && !client.trialReminderSent) {
          // 6-күн: ескерту
          try {
            await bot.telegram.sendMessage(
              client.chatId,
              t[client.lang].trial_reminder(left),
              { parse_mode: 'Markdown' },
            )
            await bot.telegram.sendMessage(
              client.chatId,
              t[client.lang].payment_info(config.KASPI_PHONE, config.KASPI_NAME, config.PRICE),
              {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback(t[client.lang].pay_btn, 'pay_now')]]),
              },
            )
            updateClient(client.chatId, { trialReminderSent: true })
          } catch (err) {
            console.error('[trial reminder]', client.chatId, err)
          }

        } else if (left <= 0) {
          // 7+ күн: тоқтату
          try {
            if (client.tenantId) await suspendTenant(client.tenantId, 'Trial expired')
            updateClient(client.chatId, { status: 'suspended' })

            await bot.telegram.sendMessage(
              client.chatId,
              t[client.lang].trial_expired,
              { parse_mode: 'Markdown' },
            )
            await bot.telegram.sendMessage(
              client.chatId,
              t[client.lang].payment_info(config.KASPI_PHONE, config.KASPI_NAME, config.PRICE),
              { parse_mode: 'Markdown' },
            )
          } catch (err) {
            console.error('[trial suspend]', client.chatId, err)
          }
        }
      }

      // Ай сайынғы жазылымды тексеру
      if (client.status === 'active' && client.paidUntil) {
        const passed = daysPassed(client.paidUntil)

        if (passed === -1) {
          // 1 күн қалды — ескерту
          try {
            await bot.telegram.sendMessage(
              client.chatId,
              t[client.lang].trial_reminder(1),
              { parse_mode: 'Markdown' },
            )
            await bot.telegram.sendMessage(
              client.chatId,
              t[client.lang].payment_info(config.KASPI_PHONE, config.KASPI_NAME, config.PRICE),
              { parse_mode: 'Markdown' },
            )
          } catch (err) {
            console.error('[subscription reminder]', client.chatId, err)
          }
        } else if (passed >= 0) {
          // Мерзімі өтті — тоқтату
          try {
            if (client.tenantId) await suspendTenant(client.tenantId, 'Subscription expired')
            updateClient(client.chatId, { status: 'suspended' })

            await bot.telegram.sendMessage(
              client.chatId,
              t[client.lang].trial_expired,
              { parse_mode: 'Markdown' },
            )
            await bot.telegram.sendMessage(
              client.chatId,
              t[client.lang].payment_info(config.KASPI_PHONE, config.KASPI_NAME, config.PRICE),
              { parse_mode: 'Markdown' },
            )
          } catch (err) {
            console.error('[subscription suspend]', client.chatId, err)
          }
        }
      }
    }
  }, {
    timezone: 'Asia/Almaty',
  })

  console.log('✅ Trial cron started (daily 09:00 Almaty)')
}
