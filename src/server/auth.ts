import { createHmac, timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'

const COOKIE = 'ugc_session'
const MAX_AGE = 30 * 24 * 3600

/** Single-user auth: the session cookie is an HMAC of the password, so changing the password logs everyone out. */
export function createAuth(password: string, secret = password) {
  const token = createHmac('sha256', secret).update(`ugc-session:${password}`).digest('hex')

  const same = (a: string, b: string) => {
    const x = Buffer.from(a)
    const y = Buffer.from(b)
    return x.length === y.length && timingSafeEqual(x, y)
  }

  const middleware: MiddlewareHandler = async (c, next) => {
    const cookie = getCookie(c, COOKIE)
    if (!cookie || !same(cookie, token)) return c.json({ error: 'unauthorized' }, 401)
    await next()
  }

  return {
    middleware,
    login(c: Parameters<MiddlewareHandler>[0], attempt: string): boolean {
      if (!same(attempt, password)) return false
      setCookie(c, COOKIE, token, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: c.req.url.startsWith('https://') || c.req.header('x-forwarded-proto') === 'https',
        path: '/',
        maxAge: MAX_AGE,
      })
      return true
    },
    logout(c: Parameters<MiddlewareHandler>[0]) {
      deleteCookie(c, COOKIE, { path: '/' })
    },
  }
}
