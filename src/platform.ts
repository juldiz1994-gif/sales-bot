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
  const res = await api.post('/api/tenants', {
    name,
    ownerEmail: email,
    ownerPassword: password,
    timezone: 'Asia/Almaty',
    aiPersona: '',
  })
  return res.data as { id: string }
}

export async function suspendTenant(tenantId: string, reason: string): Promise<void> {
  await api.post(`/api/tenants/${tenantId}/suspend`, { reason })
}

export async function activateTenant(tenantId: string): Promise<void> {
  await api.post(`/api/tenants/${tenantId}/activate`)
}
