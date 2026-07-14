import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const schemaPattern = /^[a-z_][a-z0-9_]{0,62}$/
const migrationPattern = /^(\d{3,})_[a-z0-9_]+\.sql$/
const dryRun = process.argv.includes('--dry-run')
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations')

function databaseSchema() {
  const schema = process.env.DATABASE_SCHEMA
  if (!schema || !schemaPattern.test(schema)) {
    throw new Error('DATABASE_SCHEMA must be a safe PostgreSQL identifier: lowercase letters, digits, and underscores only.')
  }
  return schema
}

async function migrationFiles() {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort()

  for (const file of files) {
    if (!migrationPattern.test(file)) {
      throw new Error(`Invalid migration filename "${file}". Use NNN_lowercase_name.sql.`)
    }
  }

  return files
}

async function transaction(pool, callback) {
  const client = await pool.connect()
  await client.query('BEGIN')
  try {
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function main() {
  const schema = databaseSchema()
  const files = await migrationFiles()

  if (dryRun) {
    console.log(`schema: ${schema}`)
    for (const file of files) console.log(`pending check: ${file}`)
    return
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured. Set DATABASE_URL before running migrations.')
  }

  const pg = await import('pg')
  const { Pool } = pg.default ?? pg
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    options: `-c search_path=${schema},public`,
  })

  try {
    const schemaExists = await pool.query(
      'SELECT 1 FROM pg_namespace WHERE nspname = $1',
      [schema],
    )
    if (!schemaExists.rowCount) {
      throw new Error(`DATABASE_SCHEMA "${schema}" does not exist.`)
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
        version text PRIMARY KEY,
        filename text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)

    const applied = new Set(
      (await pool.query(`SELECT version FROM ${schema}.schema_migrations`)).rows.map((row) => row.version),
    )

    for (const file of files) {
      const version = file.match(migrationPattern)[1]
      if (applied.has(version)) continue

      const sql = await readFile(join(migrationsDir, file), 'utf8')
      await transaction(pool, async (client) => {
        await client.query(`SET LOCAL search_path TO ${schema}, public`)
        await client.query(sql)
        await client.query(
          `INSERT INTO ${schema}.schema_migrations (version, filename) VALUES ($1, $2)`,
          [version, file],
        )
      })
      console.log(`applied ${file}`)
    }
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
