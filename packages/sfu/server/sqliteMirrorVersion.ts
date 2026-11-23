type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] };
};

export const addMirrorVersionColumn = (db: SqliteDatabase, table: string): void => {
  const hasColumn = () =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>).some(
      (column) => column.name === "mirror_version",
    );
  if (hasColumn()) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN mirror_version INTEGER NOT NULL DEFAULT 0`);
  } catch (error) {
    if (!hasColumn()) throw error;
  }
};
