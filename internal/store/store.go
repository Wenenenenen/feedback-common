// Package store 封装 SQLite 数据库的连接、迁移与全部数据访问逻辑。
package store

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"path/filepath"

	_ "modernc.org/sqlite" // 纯 Go SQLite 驱动，注册名 "sqlite"
)

// Store 持有数据库连接。本服务写入点少，连接池固定为 1，从根上避免 SQLite 多连接写锁竞争。
type Store struct {
	db *sql.DB
}

// Open 打开（必要时创建）数据库，配置 WAL 等 PRAGMA 并执行版本化迁移。
func Open(dbPath string) (*Store, error) {
	// DSN 中显式声明关键 PRAGMA；路径统一用正斜杠以兼容 Windows 盘符路径
	dsn := filepath.ToSlash(dbPath) + "?" + url.Values{
		"_pragma": []string{
			"busy_timeout(5000)",   // 写冲突时等待 5s 而非立刻 SQLITE_BUSY
			"journal_mode(WAL)",    // WAL 模式，读写互不阻塞
			"foreign_keys(ON)",     // 开启外键级联
		},
	}.Encode()

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开 SQLite 失败: %w", err)
	}
	// 单连接串行化：WAL 仍只允许同一时刻一个写事务，单连接配合 busy_timeout 可杜绝 database is locked
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)

	s := &Store{db: db}

	// 兜底 PRAGMA：WAL 下 NORMAL 同步级别安全且更快；临时表与排序走内存
	if _, err := db.Exec(`PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY;`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("设置 PRAGMA 失败: %w", err)
	}

	if err := s.migrate(context.Background()); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("数据库迁移失败: %w", err)
	}
	return s, nil
}

// DB 暴露底层连接，仅供迁移等少量场景使用。
func (s *Store) DB() *sql.DB {
	return s.db
}

// Close 关闭数据库连接。
func (s *Store) Close() error {
	return s.db.Close()
}

// migrate 基于 PRAGMA user_version 做顺序、幂等的版本化迁移。
func (s *Store) migrate(ctx context.Context) error {
	var version int
	if err := s.db.QueryRowContext(ctx, `PRAGMA user_version;`).Scan(&version); err != nil {
		return err
	}
	for _, m := range migrations {
		if m.version <= version {
			continue
		}
		// 单个迁移包在一个事务内，失败回滚，不会停留在半升级状态
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, m.statement); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("迁移到版本 %d 失败: %w", m.version, err)
		}
		if _, err := tx.ExecContext(ctx, fmt.Sprintf(`PRAGMA user_version=%d;`, m.version)); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}
