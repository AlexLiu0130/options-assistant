import pg from 'pg'

const { Pool } = pg
const DEFAULT_SCHEMA = 'options_assistant'
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/

let pool

function requireDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required before using the database.')
  }
  return databaseUrl
}

function databaseSchema() {
  const schema = process.env.DATABASE_SCHEMA || DEFAULT_SCHEMA
  if (!SAFE_IDENTIFIER.test(schema)) {
    throw new Error('DATABASE_SCHEMA must be a safe PostgreSQL identifier: lowercase letters, digits, and underscores only.')
  }
  return schema
}

function databasePool() {
  if (!pool) {
    pool = new Pool({
      connectionString: requireDatabaseUrl(),
      max: 10,
      options: `-c search_path=${databaseSchema()},public`,
    })
  }
  return pool
}

export function query(text, params) {
  return databasePool().query(text, params)
}

export async function transaction(callback) {
  const client = await databasePool().connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Preserve the original transaction error.
    }
    throw error
  } finally {
    client.release()
  }
}

export async function closeDatabase() {
  if (!pool) return
  const closing = pool
  pool = undefined
  await closing.end()
}
