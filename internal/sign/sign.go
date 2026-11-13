// Package sign 实现媒体资源 URL 的 HMAC-SHA256 签名与过期校验（防盗链）。
package sign

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// Signer 持有 HMAC 密钥，负责签发与校验。
type Signer struct {
	key []byte
	now func() time.Time // 便于测试注入时间
}

// New 创建 Signer；key 长度至少 16 字节。
func New(key []byte) (*Signer, error) {
	if len(key) < 16 {
		return nil, fmt.Errorf("HMAC 密钥长度不足 16 字节，当前: %d", len(key))
	}
	return &Signer{key: key, now: time.Now}, nil
}

// LoadOrCreateKey 优先使用环境注入的密钥；否则从 keyPath 读取，文件不存在时生成 32 字节随机密钥并落盘（0600）。
func LoadOrCreateKey(envKey []byte, keyPath string) ([]byte, error) {
	if len(envKey) > 0 {
		return envKey, nil
	}
	if data, err := os.ReadFile(keyPath); err == nil {
		// 落盘内容为标准 base64
		raw, derr := base64.StdEncoding.DecodeString(string(data))
		if derr != nil || len(raw) < 16 {
			return nil, fmt.Errorf("密钥文件 %s 内容损坏，请删除后重启以重新生成", keyPath)
		}
		return raw, nil
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("读取密钥文件失败: %w", err)
	}

	// 首次启动：生成新密钥，目录不存在则创建
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return nil, fmt.Errorf("生成随机密钥失败: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(keyPath), 0o755); err != nil {
		return nil, fmt.Errorf("创建密钥目录失败: %w", err)
	}
	encoded := []byte(base64.StdEncoding.EncodeToString(raw))
	if err := os.WriteFile(keyPath, encoded, 0o600); err != nil {
		return nil, fmt.Errorf("写入密钥文件失败: %w", err)
	}
	return raw, nil
}

// SignURL 为资源路径生成带 exp/sign 查询参数的相对 URL（path 需以 / 开头）。
func (s *Signer) SignURL(path string, ttl time.Duration) string {
	exp := s.now().Add(ttl).Unix()
	mac := s.compute(path, exp)
	return path + "?exp=" + strconv.FormatInt(exp, 10) + "&sign=" + mac
}

// Verify 校验请求路径与查询参数：必须未过期且签名常量时间匹配。
// 返回 nil 表示通过；过期返回 ErrExpired，其余失败返回普通错误。
func (s *Signer) Verify(path string, q url.Values) error {
	expStr := q.Get("exp")
	sig := q.Get("sign")
	if expStr == "" || sig == "" {
		return fmt.Errorf("缺少签名参数")
	}
	exp, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil {
		return fmt.Errorf("过期时间参数非法")
	}
	if s.now().Unix() >= exp {
		return ErrExpired
	}
	want := s.compute(path, exp)
	if !hmac.Equal([]byte(want), []byte(sig)) {
		return fmt.Errorf("签名不匹配")
	}
	return nil
}

// ErrExpired 表示签名已过有效期。
var ErrExpired = fmt.Errorf("签名已过期")

// compute 计算规范化字符串 path+"\n"+exp 的 HMAC-SHA256，返回十六进制小写串。
func (s *Signer) compute(path string, exp int64) string {
	h := hmac.New(sha256.New, s.key)
	fmt.Fprintf(h, "%s\n%d", path, exp)
	return hex.EncodeToString(h.Sum(nil))
}
