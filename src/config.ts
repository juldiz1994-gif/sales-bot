import dotenv from 'dotenv'
dotenv.config()

function require_env(name: string): string {
  const val = process.env[name]
  if (!val) throw new Error(`Missing env var: ${name}`)
  return val
}

export const config = {
  BOT_TOKEN: require_env('BOT_TOKEN'),
  ADMIN_CHAT_ID: require_env('ADMIN_CHAT_ID'),
  PLATFORM_API_URL: require_env('PLATFORM_API_URL'),
  PLATFORM_SUPER_ADMIN_TOKEN: require_env('PLATFORM_SUPER_ADMIN_TOKEN'),
  PLATFORM_URL: require_env('PLATFORM_URL'),
  KASPI_PHONE: require_env('KASPI_PHONE'),
  KASPI_NAME: process.env.KASPI_NAME || 'Жұлдыз',
  OWNER_WHATSAPP: process.env.OWNER_WHATSAPP || '',
  DATA_FILE: process.env.DATA_FILE || './data/clients.json',
  TRIAL_DAYS: 7,
  PRICE: '7 990 ₸',
  DEMO_VIDEO_ID: process.env.DEMO_VIDEO_ID || '',
  SUPPORT_INSTAGRAM: 'https://www.instagram.com/ai_aisha_kz',
}
