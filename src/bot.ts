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
import { createTenant, activateTenant, suspendTenant } from './platform'

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

// ─── Tenant жасап, credentials жіберу (автоматты) ───────────────

async function finishRegistration(bot: Telegraf, chatId: number, state: UserState) {
  const lang = state.lang ?? 'ru'
  const email = state.email!
  const persona = state.persona ?? ''

  await bot.telegram.sendMessage(chatId, '⏳', { parse_mode: 'Markdown' })

  try {
    let tenantId: string | null = null
    let password: string | null = null

    // 1) Осы chatId-де сол email бар ма?
    const prevClient = getClient(chatId)
    if (prevClient?.email?.toLowerCase() === email && prevClient.tenantId && prevClient.password) {
      tenantId = prevClient.tenantId
      password = prevClient.password
    }

    // 2) Басқа chatId-де сол email tenant бар ма?
    if (!tenantId) {
      const found = getAllClients().find(c =>
        c.email.toLowerCase() === email &&
        c.tenantId != null &&
        c.password != null &&
        c.chatId !== chatId,
      )
      if (found) {
        tenantId = found.tenantId
        password = found.password
      }
    }

    // 3) Жаңа tenant жасау
    let isExisting = false
    if (!tenantId) {
      password = genPasswordForEmail(email)
      const tenant = await createTenant(state.name ?? '', email, password, persona)
      tenantId = tenant.id
      isExisting = tenant.isExisting
    }

    saveClient({
      chatId,
      lang,
      name: state.name ?? '',
      email,
      tenantId,
      password,
      status: 'trial',
      trialStartDate: new Date().toISOString(),
      paidUntil: null,
      trialReminderSent: false,
      createdAt: new Date().toISOString(),
    })

    if (isExisting) {
      await bot.telegram.sendMessage(chatId, t[lang].status_suspended, { parse_mode: 'Markdown' })
      await bot.telegram.sendMessage(chatId, t[lang].payment_info(config.KASPI_PHONE, config.KASPI_NAME, config.PRICE), { parse_mode: 'Markdown' })
    } else {
      await bot.telegram.sendMessage(chatId, t[lang].approved(email, password!, config.PLATFORM_URL), {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.url(
          lang === 'kz' ? '🌐 Сайтқа кіру' : '🌐 Войти на сайт',
          config.PLATFORM_URL,
        )]]),
      })
    }

    await bot.telegram.sendMessage(
      config.ADMIN_CHAT_ID,
      `📝 *${isExisting ? 'Қайта тіркелу (бұрыннан бар)' : 'Жаңа клиент тіркелді'}*\n\n👤 ${state.name}\n📧 ${email}\n🆔 Chat: ${chatId}\n🏢 Tenant: ${tenantId}${persona ? `\n\n📄 AI Persona:\n${persona.slice(0, 400)}${persona.length > 400 ? '...' : ''}` : ''}`,
      { parse_mode: 'Markdown' },
    )
  } catch (err) {
    console.error('[auto-register]', err)
    await bot.telegram.sendMessage(
      chatId,
      lang === 'kz'
        ? '❌ Техникалық қате. Жақын арада шешіледі, қайталаңыз.'
        : '❌ Техническая ошибка. Попробуйте позже.',
    )
    await bot.telegram.sendMessage(
      config.ADMIN_CHAT_ID,
      `⚠️ Тіркелу қатесі:\n👤 ${state.name}\n📧 ${email}\n🆔 ${chatId}\n\n${err}`,
    )
  }

  states.delete(chatId)
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
      await ctx.reply(t[lang].status_active(formatDate(paidUntil)), {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.url(
          lang === 'kz' ? '🌐 Сайтқа кіру' : '🌐 Войти на сайт',
          config.PLATFORM_URL,
        )]]),
      })
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

  // /expire <chatId> — admin тестілеу командасы (trial-ді дереу аяқтайды)
  bot.command('expire', async (ctx) => {
    if (String(ctx.chat.id) !== String(config.ADMIN_CHAT_ID)) return

    const parts = ctx.message.text.trim().split(/\s+/)
    const targetId = parts[1] ? parseInt(parts[1]) : NaN

    if (isNaN(targetId)) {
      await ctx.reply('❌ Пайдалану: /expire <chatId>\nМысалы: /expire 6579431757')
      return
    }

    const client = getClient(targetId)
    if (!client) {
      await ctx.reply(`❌ Клиент табылмады: ${targetId}`)
      return
    }
    if (client.status !== 'trial') {
      await ctx.reply(`⚠️ Клиент status=${client.status} (тек trial статусы үшін жұмыс жасайды)`)
      return
    }

    try {
      if (client.tenantId) await suspendTenant(client.tenantId, 'Test: trial force expired')
      updateClient(targetId, { status: 'suspended' })

      await bot.telegram.sendMessage(
        targetId,
        t[client.lang].trial_expired,
        { parse_mode: 'Markdown' },
      )
      await bot.telegram.sendMessage(
        targetId,
        t[client.lang].payment_info(config.KASPI_PHONE, config.KASPI_NAME, config.PRICE),
        { parse_mode: 'Markdown' },
      )

      await ctx.reply(`✅ ${client.name} (${client.email}) — trial аяқталды, suspended болды`)
    } catch (err) {
      console.error('[force expire]', err)
      await ctx.reply(`❌ Қате: ${err}`)
    }
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
      state.persona = ''
      states.set(chatId, state)
      await finishRegistration(bot, chatId, state)
      return
    }
  })

  // ─── Фото (чек немесе persona қадамын өткізу) ──────────────────

  bot.on(message('photo'), async (ctx) => {
    const chatId = ctx.chat.id
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id
    await handleCheck(bot, chatId, fileId, 'photo')
  })

  // ─── PDF / Document ─────────────────────────────────────────────

  bot.on(message('document'), async (ctx) => {
    const chatId = ctx.chat.id
    const doc = ctx.message.document
    await handleCheck(bot, chatId, doc.file_id, 'document')
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
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.url(
            client.lang === 'kz' ? '🌐 Сайтқа кіру' : '🌐 Войти на сайт',
            config.PLATFORM_URL,
          )]]),
        },
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
