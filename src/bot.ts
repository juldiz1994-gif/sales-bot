import { Telegraf, Markup } from 'telegraf'
import { message } from 'telegraf/filters'
import { config } from './config'
import { t, type Lang } from './i18n'
import {
  getClient,
  getClientByEmail,
  saveClient,
  updateClient,
  type UserState,
  type ClientRecord,
} from './store'
import { createTenant, activateTenant } from './platform'

// Жады: боттағы ағымдағы қадам (сервер өшсе тазаланады)
const states = new Map<number, UserState>()

function genPassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#'
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

function daysLeft(isoDate: string): number {
  const end = new Date(isoDate).getTime() + config.TRIAL_DAYS * 86_400_000
  return Math.max(0, Math.ceil((end - Date.now()) / 86_400_000))
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

// ─── Админге хабарлама жіберу ────────────────────────────────────

async function notifyAdmin(
  bot: Telegraf,
  type: 'registration' | 'payment',
  client: Pick<ClientRecord, 'chatId' | 'name' | 'email' | 'tenantId'>,
  fileId?: string,
  fileType?: 'photo' | 'document',
) {
  const isPayment = type === 'payment'
  const caption = isPayment
    ? `💳 *Жаңарту төлемі / Продление*\n\n👤 ${client.name}\n📧 ${client.email}\n🆔 Chat: ${client.chatId}\n🏢 Tenant: ${client.tenantId ?? '—'}`
    : `📝 *Жаңа тіркелу / Регистрация*\n\n👤 ${client.name}\n📧 ${client.email}\n🆔 Chat: ${client.chatId}`

  const action = isPayment ? 'renewal' : 'new'
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Растау', `approve_${client.chatId}_${action}`),
      Markup.button.callback('❌ Бас тарту', `reject_${client.chatId}_${action}`),
    ],
  ])

  if (fileId && fileType === 'photo') {
    await bot.telegram.sendPhoto(config.ADMIN_CHAT_ID, fileId, { caption, parse_mode: 'Markdown', ...keyboard })
  } else if (fileId && fileType === 'document') {
    await bot.telegram.sendDocument(config.ADMIN_CHAT_ID, fileId, { caption, parse_mode: 'Markdown', ...keyboard })
  } else {
    await bot.telegram.sendMessage(config.ADMIN_CHAT_ID, caption, { parse_mode: 'Markdown', ...keyboard })
  }
}

// ─── Чек өңдеу (photo/document) ─────────────────────────────────

async function handleCheck(
  bot: Telegraf,
  chatId: number,
  fileId: string,
  fileType: 'photo' | 'document',
) {
  const client = getClient(chatId)
  const state = states.get(chatId)

  // Белсенді тіркелу флоуы
  if (state?.step === 'payment') {
    const lang = state.lang ?? 'ru'
    const name = state.name ?? ''
    const email = state.email ?? ''

    saveClient({
      chatId,
      lang,
      name,
      email,
      tenantId: null,
      password: null,
      status: 'pending',
      trialStartDate: null,
      paidUntil: null,
      trialReminderSent: false,
      createdAt: new Date().toISOString(),
    })

    await bot.telegram.sendMessage(chatId, t[lang].check_received, { parse_mode: 'Markdown' })
    await notifyAdmin(bot, 'registration', { chatId, name, email, tenantId: null }, fileId, fileType)
    states.delete(chatId)
    return
  }

  // Жаңарту флоуы (тоқтатылған клиент)
  if (client?.status === 'suspended') {
    updateClient(chatId, { status: 'pending_payment' })
    await bot.telegram.sendMessage(chatId, t[client.lang].check_received, { parse_mode: 'Markdown' })
    await notifyAdmin(bot, 'payment', { chatId, name: client.name, email: client.email, tenantId: client.tenantId }, fileId, fileType)
  }
}

// ─── Бот орнату ──────────────────────────────────────────────────

export function setupBot(bot: Telegraf) {

  // /start
  bot.start(async (ctx) => {
    const chatId = ctx.chat.id
    const client = getClient(chatId)

    if (client && (client.status === 'trial' || client.status === 'active')) {
      await ctx.reply(t[client.lang].already_active, { parse_mode: 'Markdown' })
      return
    }

    states.set(chatId, { step: 'lang' })
    await ctx.reply(
      t.kz.choose_lang,
      Markup.inlineKeyboard([
        [Markup.button.callback('🇰🇿 Қазақша', 'lang_kz')],
        [Markup.button.callback('🇷🇺 Русский', 'lang_ru')],
      ]),
    )
  })

  // /status
  bot.command('status', async (ctx) => {
    const client = getClient(ctx.chat.id)
    if (!client) {
      await ctx.reply('Сіз тіркелмегенсіз. /start')
      return
    }
    const { lang, status, trialStartDate, paidUntil } = client
    if (status === 'trial' && trialStartDate) {
      await ctx.reply(t[lang].status_trial(daysLeft(trialStartDate)), { parse_mode: 'Markdown' })
    } else if (status === 'active' && paidUntil) {
      await ctx.reply(t[lang].status_active(formatDate(paidUntil)), { parse_mode: 'Markdown' })
    } else {
      await ctx.reply(t[lang].status_suspended, { parse_mode: 'Markdown' })
      await ctx.reply(
        t[lang].payment_info(config.KASPI_PHONE, config.KASPI_NAME, config.PRICE),
        { parse_mode: 'Markdown' },
      )
    }
  })

  // /pay
  bot.command('pay', async (ctx) => {
    const client = getClient(ctx.chat.id)
    const lang: Lang = client?.lang ?? 'ru'
    await ctx.reply(
      t[lang].payment_info(config.KASPI_PHONE, config.KASPI_NAME, config.PRICE),
      { parse_mode: 'Markdown' },
    )
  })

  // /help
  bot.help(async (ctx) => {
    const lang: Lang = getClient(ctx.chat.id)?.lang ?? 'ru'
    await ctx.reply(t[lang].help, { parse_mode: 'Markdown' })
  })

  // ─── Тіл таңдау ────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handleLang(ctx: any, lang: Lang) {
    const chatId = ctx.chat!.id
    const state = states.get(chatId)
    if (!state || state.step !== 'lang') { await ctx.answerCbQuery(); return }

    state.lang = lang
    state.step = 'name'
    states.set(chatId, state)

    await ctx.answerCbQuery()
    await ctx.editMessageText(t[lang].welcome(config.PRICE), {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback(t[lang].start_btn, 'start_reg')]]),
    })
  }

  bot.action('lang_kz', (ctx) => handleLang(ctx, 'kz'))
  bot.action('lang_ru', (ctx) => handleLang(ctx, 'ru'))

  // ─── Тіркелуді бастау ──────────────────────────────────────────

  bot.action('start_reg', async (ctx) => {
    const chatId = ctx.chat!.id
    const state = states.get(chatId)
    if (!state) { await ctx.answerCbQuery(); return }

    const lang = state.lang ?? 'ru'
    state.step = 'name'
    states.set(chatId, state)

    await ctx.answerCbQuery()
    await ctx.reply(t[lang].ask_name, { parse_mode: 'Markdown' })
  })

  // ─── Мәтін өңдеу ───────────────────────────────────────────────

  bot.on(message('text'), async (ctx) => {
    const chatId = ctx.chat.id
    const text = ctx.message.text.trim()
    const state = states.get(chatId)

    // Бот командасын елемеу
    if (text.startsWith('/')) return

    if (!state) {
      // Тоқтатылған клиент хабарласса — төлем ақпаратын жіберу
      const client = getClient(chatId)
      if (client?.status === 'suspended') {
        await ctx.reply(t[client.lang].status_suspended, { parse_mode: 'Markdown' })
        await ctx.reply(
          t[client.lang].payment_info(config.KASPI_PHONE, config.KASPI_NAME, config.PRICE),
          { parse_mode: 'Markdown' },
        )
      }
      return
    }

    const lang = state.lang ?? 'ru'

    // Бизнес аты
    if (state.step === 'name') {
      state.name = text
      state.step = 'email'
      states.set(chatId, state)
      await ctx.reply(t[lang].ask_email, { parse_mode: 'Markdown' })
      return
    }

    // Email
    if (state.step === 'email') {
      const email = text.toLowerCase()
      if (!email.includes('@') || !email.includes('.')) {
        await ctx.reply(t[lang].invalid_email, { parse_mode: 'Markdown' })
        return
      }

      state.email = email
      state.step = 'done'
      states.set(chatId, state)

      // Тіркелу сұрауын сақтап, adminге жіберу
      saveClient({
        chatId,
        lang,
        name: state.name ?? '',
        email,
        tenantId: null,
        password: null,
        status: 'pending',
        trialStartDate: null,
        paidUntil: null,
        trialReminderSent: false,
        createdAt: new Date().toISOString(),
      })

      await ctx.reply(t[lang].pending, { parse_mode: 'Markdown' })
      await notifyAdmin(bot, 'registration', { chatId, name: state.name ?? '', email, tenantId: null })
      states.delete(chatId)
    }
  })

  // ─── Фото (чек) ────────────────────────────────────────────────

  bot.on(message('photo'), async (ctx) => {
    const chatId = ctx.chat.id
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id
    await handleCheck(bot, chatId, fileId, 'photo')
  })

  // ─── PDF (чек) ─────────────────────────────────────────────────

  bot.on(message('document'), async (ctx) => {
    const chatId = ctx.chat.id
    await handleCheck(bot, chatId, ctx.message.document.file_id, 'document')
  })

  // ─── Admin: Растау (жаңа тіркелу) ──────────────────────────────

  bot.action(/^approve_(\d+)_new$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1])
    const client = getClient(chatId)
    if (!client) { await ctx.answerCbQuery('Клиент табылмады'); return }

    await ctx.answerCbQuery('⏳ Жасалуда...')

    try {
      let tenantId = client.tenantId
      let password = client.password

      // Email бойынша бұрынғы tenant тексеру (1 email = 1 tenant)
      if (!tenantId) {
        const existingByEmail = getClientByEmail(client.email)
        if (existingByEmail?.tenantId && existingByEmail?.password) {
          tenantId = existingByEmail.tenantId
          password = existingByEmail.password
          updateClient(chatId, {
            tenantId,
            password,
            status: 'trial',
            trialStartDate: new Date().toISOString(),
          })
        } else {
          password = password ?? genPassword()
          const tenant = await createTenant(client.name, client.email, password)
          tenantId = tenant.id
          updateClient(chatId, {
            tenantId,
            password,
            status: 'trial',
            trialStartDate: new Date().toISOString(),
          })
        }
      } else {
        password = password ?? genPassword()
        if (client.status !== 'trial' && client.status !== 'active') {
          updateClient(chatId, { status: 'trial', trialStartDate: new Date().toISOString() })
        }
      }

      await bot.telegram.sendMessage(
        chatId,
        t[client.lang].approved(client.email, password, config.PLATFORM_URL, config.OWNER_WHATSAPP),
        { parse_mode: 'Markdown' },
      )

      const msg1 = ctx.callbackQuery?.message
      if (msg1 && 'caption' in msg1) {
        await ctx.editMessageCaption(`✅ РАСТАЛДЫ — ${client.name} (${client.email})`)
      } else {
        await ctx.editMessageText(`✅ РАСТАЛДЫ — ${client.name} (${client.email})`)
      }
    } catch (err) {
      console.error('[approve_new]', err)
      await ctx.telegram.sendMessage(config.ADMIN_CHAT_ID, `❌ Tenant жасау қатесі:\n${err}`)
    }
  })

  // ─── Admin: Растау (жаңарту төлемі) ────────────────────────────

  bot.action(/^approve_(\d+)_renewal$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1])
    const client = getClient(chatId)
    if (!client?.tenantId) { await ctx.answerCbQuery('Клиент табылмады'); return }

    await ctx.answerCbQuery('⏳ Белсендірілуде...')

    try {
      await activateTenant(client.tenantId)

      const paidUntil = new Date()
      paidUntil.setDate(paidUntil.getDate() + 30)

      updateClient(chatId, {
        status: 'active',
        paidUntil: paidUntil.toISOString(),
        trialReminderSent: false,
      })

      await bot.telegram.sendMessage(
        chatId,
        t[client.lang].renewal_approved(config.PLATFORM_URL),
        { parse_mode: 'Markdown' },
      )

      const msg2 = ctx.callbackQuery?.message
      if (msg2 && 'caption' in msg2) {
        await ctx.editMessageCaption(`✅ ЖАҢАРТЫЛДЫ — ${client.name} дейін ${formatDate(paidUntil.toISOString())}`)
      } else {
        await ctx.editMessageText(`✅ ЖАҢАРТЫЛДЫ — ${client.name} дейін ${formatDate(paidUntil.toISOString())}`)
      }
    } catch (err) {
      console.error('[approve_renewal]', err)
      await ctx.telegram.sendMessage(config.ADMIN_CHAT_ID, `❌ Активация қатесі:\n${err}`)
    }
  })

  // ─── Admin: Бас тарту ──────────────────────────────────────────

  bot.action(/^reject_(\d+)_(new|renewal)$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1])
    const client = getClient(chatId)
    if (!client) { await ctx.answerCbQuery(); return }

    const isPayment = ctx.match[2] === 'renewal'
    updateClient(chatId, { status: isPayment ? 'suspended' : 'pending' })

    await bot.telegram.sendMessage(
      chatId,
      isPayment ? t[client.lang].payment_rejected : t[client.lang].rejected,
      { parse_mode: 'Markdown' },
    )

    await ctx.answerCbQuery('❌ Бас тартылды')
    const msg3 = ctx.callbackQuery?.message
    if (msg3 && 'caption' in msg3) {
      await ctx.editMessageCaption(`❌ БАС ТАРТЫЛДЫ — ${client.name}`)
    } else {
      await ctx.editMessageText(`❌ БАС ТАРТЫЛДЫ — ${client.name}`)
    }
  })
}
