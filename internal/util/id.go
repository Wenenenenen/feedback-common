// Package util 放置跨包复用的基础小工具。
package util

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
)

// NewUUID 基于 crypto/rand 生成 RFC 4122 v4 格式的随机 UUID（小写、带连字符）。
func NewUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("生成随机 UUID 失败: %w", err)
	}
	// 设置 version 4（随机）与 variant 10xx 标记位
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	dst := make([]byte, 36)
	hex.Encode(dst[0:8], b[0:4])
	dst[8] = '-'
	hex.Encode(dst[9:13], b[4:6])
	dst[13] = '-'
	hex.Encode(dst[14:18], b[6:8])
	dst[18] = '-'
	hex.Encode(dst[19:23], b[8:10])
	dst[23] = '-'
	hex.Encode(dst[24:36], b[10:16])
	return string(dst), nil
}
