import { createHmac } from 'crypto'
import { Telegraf, Markup } from 'telegraf'
import { message } from 'telegraf/filters'
import { config } from './config'
import { t, type Lang } from './i18n'
import {
  getClient,
  getAllClients,
  saveClient,
  updateClient,
  type UserState,
  type ClientRecord,
} from './store'
import { createTenant, activateTenant } from './platform'
import { detectUrl, extractFromUrl } from './persona'

const states = new Map<number, UserState>()

function genPasswordForEmail(email: string): string {
  const h = createHmac('sha256', 'sb-pw-salt-2024').update(email.toLowerCase()).digest('hex')
  return h.slice(0, 8) + 'Zq9!'
}

function daysLeft(isoDate: string): number {
  const end = new Date(isoDate).getTime() + config.TRIAL_DAYS * 86_400_000
  return Math.max(0, Math.ceil((end - Date.now()) / 86_400_000))
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

// ─── Төлем чегін adminге жіберу ──────────────────────────────────

async function notifyPayment(
  bot: Telegraf,
  client: Pick<ClientRecord, 'chatId' | 'name' | 'email' | 'tenantId'>,
  fileId?: string,
  fileType?: 'photo' | 'document',
) {
  const caption = `💳 *Жаңарту төлемі*\n\n👤 ${client.name}\n📧 ${client.email}\n🆔 Chat: ${client.chatId}\n🏢 Tenant: ${client.tenantId ?? '—'}`

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Растау', `approve_${client.chatId}_renewal`),
      Markup.button.callback('❌ Бас тарту', `reject_${client.chatId}_renewal`),
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

// ─── Чек өңдеу (тек тоқтатылған клиент үшін) ───────────────────

async function handleCheck(
  bot: Telegraf,
  chatId: number,
  fileId: string,
  fileType: 'photo' | 'document',
) {
  const client = getClient(chatId)
  if (client?.status === 'suspended') {
    updateClient(chatId, { status: 'pending_payment' })
    await bot.telegram.sendMessage(chatId, t[client.lang].check_received, { parse_mode: 'Markdown' })
    await notifyPayment(bot, { chatId, name: client.name, email: client.email, tenantId: client.tenantId }, fileId, fileType)
  }
}

// ─── Тіркелу сұрауын adminге жіберіп, күту хабары ──────────────

async function finishRegistration(bot: Telegraf, chatId: number, state: UserState) {
  const lang = state.lang ?? 'ru'
  const email = state.email!
  const name = state.name ?? ''
  const persona = state.persona ?? ''

  // Бұрыннан tenant бар ма? (қайта тіркелу)
  const prevClient = getClient(chatId)
  const existingByEmail = getAllClients().find(c =>
    c.email.toLowerCase() === email && c.tenantId != null && c.chatId !== chatId,
  )

  if (
    (prevClient?.email?.toLowerCase() === email && prevClient.tenantId) ||
    existingByEmail
  ) {
    // Бұрыннан бар — тікелей suspended + төлем
    await bot.telegram.sendMessage(chatId, t[lang].status_suspended, { parse_mode: 'Markdown' })
    await bot.telegram.sendMessage(
      chatId,
      t[lang].payment_info(config.KASPI_PHONE, config.KASPI_NAME, config.PRICE),
      { parse_mode: 'Markdown' },
    )
    states.delete(chatId)
    return
  }

  // Жаңа клиент — pending күйде сақтап, adminге жіберу
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

  await bot.telegram.sendMessage(chatId, t[lang].pending, { parse_mode: 'Markdown' })

  await bot.telegram.sendMessage(
    config.ADMIN_CHAT_ID,
    `📝 *Жаңа тіркелу сұрауы*\n\n👤 ${name}\n📧 ${email}\n🆔 Chat: ${chatId}${persona ? `\n\n📄 AI Persona:\n${persona.slice(0, 500)}${persona.length > 500 ? '...' : ''}` : ''}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Растау', `approve_${chatId}_reg`),
          Markup.button.callback('❌ Бас тарту', `reject_${chatId}_reg`),
        ],
      ]),
    },
  )

  states.delete(chatId)
}

// ─── Admin: Жаңа тіркелуді растау ───────────────────────────────

async function approveRegistration(bot: Telegraf, chatId: number) {
  const client = getClient(chatId)
  if (!client || client.status !== 'pending') return

  try {
    const password = genPasswordForEmail(client.email)
    const tenant = await createTenant(client.name, client.email, password, '')
    const tenantId = tenant.id

    updateClient(chatId, {
      tenantId,
      password,
      status: 'trial',
      trialStartDate: new Date().toISOString(),
    })

    await bot.telegram.sendMessage(
      chatId,
      t[client.lang].approved(client.email, password, config.PLATFORM_URL),
      { parse_mode: 'Markdown' },
    )
  } catch (err) {
    console.error('[approveRegistration]', err)
    await bot.telegram.sendMessage(
      config.ADMIN_CHAT_ID,
      `⚠️ Tenant жасау қатесі:\n👤 ${client.name}\n📧 ${client.email}\n\n${err}`,
    )
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

    if (client && client.status === 'pending') {
      await ctx.reply(t[client.lang].pending, { parse_mode: 'Markdown' })
      return
    }

    if (client && (client.status === 'suspended' || client.status === 'pending_payment')) {
      await ctx.reply(t[client.lang].status_suspended, { parse_mode: 'Markdown' })
      await ctx.reply(
        t[client.lang].payment_info(config.KASPI_PHONE, config.KASPI_NAME, config.PRICE),
        { parse_mode: 'Markdown' },
      )
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
    if (!client) { await ctx.reply('Сіз тіркелмегенсіз. /start'); return }
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

  // ─── Persona батон өңдегіштер ───────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handlePersonaAction(ctx: any, mode: 'pdf' | 'url' | 'text' | 'skip') {
    const chatId = ctx.chat!.id
    const state = states.get(chatId)
    if (!state || state.step !== 'persona') { await ctx.answerCbQuery(); return }
    await ctx.answerCbQuery()

    if (mode === 'skip') {
      state.persona = ''
      states.set(chatId, state)
      await finishRegistration(bot, chatId, state)
      return
    }

    const lang = state.lang ?? 'ru'
    state.personaMode = mode
    states.set(chatId, state)

    const modeMsg = mode === 'pdf'
      ? t[lang].persona_mode_pdf
      : mode === 'url'
        ? t[lang].persona_mode_url
        : t[lang].persona_mode_text

    await ctx.editMessageText(`${t[lang].ask_persona}\n\n${modeMsg}`, { parse_mode: 'Markdown' })
  }

  bot.action('persona_pdf',  (ctx) => handlePersonaAction(ctx, 'pdf'))
  bot.action('persona_url',  (ctx) => handlePersonaAction(ctx, 'url'))
  bot.action('persona_text', (ctx) => handlePersonaAction(ctx, 'text'))
  bot.action('skip_persona', (ctx) => handlePersonaAction(ctx, 'skip'))

  // ─── Мәтін өңдеу ───────────────────────────────────────────────

  bot.on(message('text'), async (ctx) => {
    const chatId = ctx.chat.id
    const text = ctx.message.text.trim()
    const state = states.get(chatId)

    if (text.startsWith('/')) return

    if (!state) {
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

      // Осы chatId бұрын БАСҚА email-мен тіркелген бе? → тегін мерзім берілмейді
      const prevClient = getClient(chatId)
      if (prevClient && prevClient.email.toLowerCase() !== email) {
        await bot.telegram.sendMessage(chatId, t[lang].status_suspended, { parse_mode: 'Markdown' })
        await bot.telegram.sendMessage(
          chatId,
          t[lang].payment_info(config.KASPI_PHONE, config.KASPI_NAME, config.PRICE),
          { parse_mode: 'Markdown' },
        )
        states.delete(chatId)
        return
      }

      state.email = email
      state.step = 'persona'
      states.set(chatId, state)

      await ctx.reply(
        t[lang].ask_persona,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback(t[lang].btn_pdf,  'persona_pdf'),
              Markup.button.callback(t[lang].btn_url,  'persona_url'),
              Markup.button.callback(t[lang].btn_text, 'persona_text'),
            ],
            [Markup.button.callback(t[lang].skip_btn, 'skip_persona')],
          ]),
        },
      )
      return
    }

    // Persona — мәтін немесе URL (режим таңдалған болса)
    if (state.step === 'persona' && state.personaMode) {
      if (state.personaMode === 'url') {
        const url = detectUrl(text) ?? text
        await ctx.reply(t[lang].persona_reading_url, { parse_mode: 'Markdown' })
        try {
          state.persona = await extractFromUrl(url)
        } catch {
          state.persona = text
        }
      } else {
        state.persona = text
      }
      await ctx.reply(t[lang].persona_received, { parse_mode: 'Markdown' })
      states.set(chatId, state)
      await finishRegistration(bot, chatId, state)
    }
  })

  // ─── Фото (чек немесе persona қадамын өткізу) ──────────────────

  bot.on(message('photo'), async (ctx) => {
    const chatId = ctx.chat.id
    const state = states.get(chatId)

    // Persona қадамында фото жіберсе — өткізіп жіберу
    if (state?.step === 'persona' && state.personaMode) {
      const lang = state.lang ?? 'ru'
      state.persona = ''
      states.set(chatId, state)
      await ctx.reply(t[lang].persona_received, { parse_mode: 'Markdown' })
      await finishRegistration(bot, chatId, state)
      return
    }

    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id
    await handleCheck(bot, chatId, fileId, 'photo')
  })

  // ─── PDF / Document ─────────────────────────────────────────────

  bot.on(message('document'), async (ctx) => {
    const chatId = ctx.chat.id
    const state = states.get(chatId)
    const doc = ctx.message.document

    // Persona қадамында PDF жіберсе — adminге жібер
    if (state?.step === 'persona' && state.personaMode === 'pdf') {
      const lang = state.lang ?? 'ru'
      state.persona = `[PDF файл жүктелді: ${doc.file_name ?? 'document.pdf'}]`
      states.set(chatId, state)
      // PDF-ті adminге жіберу
      try {
        await bot.telegram.sendDocument(
          config.ADMIN_CHAT_ID,
          doc.file_id,
          { caption: `📎 AI Persona PDF\n👤 ${state.name}\n📧 ${state.email}\n\nAI Persona бетіне қосыңыз.` },
        )
      } catch { /* ignore */ }
      await ctx.reply(t[lang].persona_received, { parse_mode: 'Markdown' })
      await finishRegistration(bot, chatId, state)
      return
    }

    await handleCheck(bot, chatId, doc.file_id, 'document')
  })

  // ─── Admin: Жаңа тіркелуді растау/бас тарту ────────────────────

  bot.action(/^approve_(\d+)_reg$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1])
    const client = getClient(chatId)
    if (!client || client.status !== 'pending') {
      await ctx.answerCbQuery('Клиент табылмады немесе статус өзгерген')
      return
    }

    await ctx.answerCbQuery('⏳ Тіркелуде...')

    await approveRegistration(bot, chatId)

    const updatedClient = getClient(chatId)
    const msg = ctx.callbackQuery?.message
    if (msg && 'text' in msg) {
      await ctx.editMessageText(
        `✅ РАСТАЛДЫ — ${client.name} (${client.email})\n🏢 Tenant: ${updatedClient?.tenantId ?? '—'}`,
        { parse_mode: 'Markdown' },
      )
    }
  })

  bot.action(/^reject_(\d+)_reg$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1])
    const client = getClient(chatId)
    if (!client) { await ctx.answerCbQuery(); return }

    updateClient(chatId, { status: 'suspended' })

    await bot.telegram.sendMessage(chatId, t[client.lang].rejected, { parse_mode: 'Markdown' })
    await ctx.answerCbQuery('❌ Бас тартылды')

    const msg = ctx.callbackQuery?.message
    if (msg && 'text' in msg) {
      await ctx.editMessageText(`❌ БАС ТАРТЫЛДЫ — ${client.name} (${client.email})`)
    }
  })

  // ─── Admin: Төлемді растау ──────────────────────────────────────

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

      const msg = ctx.callbackQuery?.message
      if (msg && 'caption' in msg) {
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

  bot.action(/^reject_(\d+)_renewal$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1])
    const client = getClient(chatId)
    if (!client) { await ctx.answerCbQuery(); return }

    updateClient(chatId, { status: 'suspended' })

    await bot.telegram.sendMessage(
      chatId,
      t[client.lang].payment_rejected,
      { parse_mode: 'Markdown' },
    )

    await ctx.answerCbQuery('❌ Бас тартылды')
    const msg = ctx.callbackQuery?.message
    if (msg && 'caption' in msg) {
      await ctx.editMessageCaption(`❌ БАС ТАРТЫЛДЫ — ${client.name}`)
    } else {
      await ctx.editMessageText(`❌ БАС ТАРТЫЛДЫ — ${client.name}`)
    }
  })
}
