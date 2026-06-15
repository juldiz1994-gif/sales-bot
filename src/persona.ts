import axios from 'axios'
import { load } from 'cheerio'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>

const MAX_LEN = 3000

export function detectUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s]+/)
  return m ? m[0] : null
}

export async function extractFromUrl(url: string): Promise<string> {
  const res = await axios.get<string>(url, {
    timeout: 12_000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SalesBot/1.0)' },
  })
  const $ = load(res.data)
  $('script, style, nav, footer, header, iframe, noscript').remove()
  const text = $('body').text().replace(/\s+/g, ' ').trim()
  return text.slice(0, MAX_LEN)
}

export async function extractFromPdf(buffer: Buffer): Promise<string> {
  const data = await pdfParse(buffer)
  return data.text.slice(0, MAX_LEN)
}
