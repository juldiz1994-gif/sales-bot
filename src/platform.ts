import axios from 'axios'
import { config } from './config'

const api = axios.create({
  baseURL: config.PLATFORM_API_URL,
  headers: {
    Authorization: `Bearer ${config.PLATFORM_SUPER_ADMIN_TOKEN}`,
    'Content-Type': 'application/json',
  },
  timeout: 15_000,
})

export async function createTenant(name: string, email: string, password: string): Promise<{ id: string }> {
  try {
    const res = await api.post('/api/tenants', {
      name,
      ownerEmail: email,
      ownerPassword: password,
      timezone: 'Asia/Almaty',
      aiPersona: '',
    })
    return res.data as { id: string }
  } catch (err: any) {
    if (err?.response?.status === 409) {
      const existing = err.response.data
      if (existing?.id) return { id: existing.id }
      const list = await api.get('/api/tenants')
      const found = (list.data as any[]).find((t: any) => t.owner?.email === email || t.ownerEmail === email || t.email === email)
      if (found?.id) return { id: found.id }
    }
    throw err
  }
}

export async function suspendTenant(tenantId: string, reason: string): Promise<void> {
  await api.post(`/api/tenants/${tenantId}/suspend`, { reason })
}

export async function activateTenant(tenantId: string): Promise<void> {
  await api.post(`/api/tenants/${tenantId}/activate`)
}
