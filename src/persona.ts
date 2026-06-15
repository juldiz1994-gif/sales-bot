import axios from 'axios'
import * as cheerio from 'cheerio'
import pdf from 'pdf-parse'

const MAX_LEN = 3000

export function detectUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s]+/)
  return m ? m[0] : null
}

export async function extractFromUrl(url: string): Promise<string> {
  const res = await axios.get(url, {
    timeout: 12_000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SalesBot/1.0)' },
  })
  const $ = cheerio.load(res.data as string)
  $('script, style, nav, footer, header, iframe, noscript').remove()
  const text = $('body').text().replace(/\s+/g, ' ').trim()
  return text.slice(0, MAX_LEN)
}

export async function extractFromPdf(buffer: Buffer): Promise<string> {
  const data = await pdf(buffer)
  return data.text.slice(0, MAX_LEN)
}
