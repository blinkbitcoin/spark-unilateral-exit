/**
 * Test helpers for PostgreSQL storage tests.
 * This file is ONLY used by wasm tests, not production code.
 *
 * Requires Docker to be running — spins up a PostgreSQL container via testcontainers.
 */

const path = require("path");

// Resolve dependencies from the postgres-storage package where they're installed
let GenericContainer, Wait, Pool;
try {
  const pgStoragePath = path.join(__dirname, "postgres-storage", "node_modules");
  const tc = require(path.join(pgStoragePath, "testcontainers"));
  GenericContainer = tc.GenericContainer;
  Wait = tc.Wait;
  Pool = require(path.join(pgStoragePath, "pg")).Pool;
} catch (error) {
  try {
    const mainModule = require.main;
    if (mainModule) {
      const tc = mainModule.require("testcontainers");
      GenericContainer = tc.GenericContainer;
      Wait = tc.Wait;
      Pool = mainModule.require("pg").Pool;
    } else {
      const tc = require("testcontainers");
      GenericContainer = tc.GenericContainer;
      Wait = tc.Wait;
      Pool = require("pg").Pool;
    }
  } catch (fallbackError) {
    throw new Error(
      `testcontainers or pg not found. Please install them in postgres-storage: cd js/postgres-storage && npm install\n` +
        `Original error: ${error.message}\nFallback error: ${fallbackError.message}`
    );
  }
}

const PG_IMAGE = "postgres:16-alpine";
const PG_USER = "test";
const PG_PASSWORD = "test";
const PG_PORT = 5432;

let _container = null;
let _containerHost = null;
let _containerPort = null;

/**
 * Ensure a shared PostgreSQL container is running.
 * Returns { host, port } for connection.
 */
async function ensureContainer() {
  if (_container) {
    return { host: _containerHost, port: _containerPort };
  }

  _container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({
      POSTGRES_USER: PG_USER,
      POSTGRES_PASSWORD: PG_PASSWORD,
      POSTGRES_DB: "template_test",
    })
    .withExposedPorts(PG_PORT)
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2)
    )
    .start();

  _containerHost = _container.getHost();
  _containerPort = _container.getMappedPort(PG_PORT);

  return { host: _containerHost, port: _containerPort };
}

let _dbCounter = 0;

/**
 * Create a fresh database for a single test, returning a connection string.
 * Each database name is unique to avoid cross-test interference.
 *
 * @param {string} testName - Used as part of the database name (sanitised)
 * @returns {Promise<string>} PostgreSQL connection string
 */
async function createTestConnectionString(testName) {
  const { host, port } = await ensureContainer();

  // Sanitise into a valid PG identifier
  const safeName = testName.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  _dbCounter++;
  const dbName = `test_${safeName}_${_dbCounter}`;

  // Connect to the default database to CREATE DATABASE
  const adminPool = new Pool({
    host,
    port,
    user: PG_USER,
    password: PG_PASSWORD,
    database: "template_test",
    max: 1,
  });

  try {
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await adminPool.end();
  }

  return `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${dbName}`;
}

module.exports = { createTestConnectionString };
