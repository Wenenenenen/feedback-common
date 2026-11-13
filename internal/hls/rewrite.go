// Package hls 负责签名校验、m3u8 动态重写与 HLS 媒体文件分发。
package hls

import (
	"bufio"
	"bytes"
	"io"
	"strings"
)

// RewritePlaylist 逐行重写 m3u8：注释行（# 开头）原样保留，URI 行替换为 signFn 生成的新签名 URL。
// 适用于 master（重写 v_n.m3u8）与 variant（重写 .ts 分片）两层 playlist。
func RewritePlaylist(r io.Reader, signFn func(uri string) string) ([]byte, error) {
	scanner := bufio.NewScanner(r)
	// playlist 体积小，但分片很多时单行/总长可能偏大，放大缓冲
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)

	var out bytes.Buffer
	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)
		switch {
		case trimmed == "":
			out.WriteByte('\n')
		case strings.HasPrefix(trimmed, "#"):
			// 标签与注释原样输出，包含 EXT-X-STREAM-INF / EXTINF / ENDLIST
			out.WriteString(line)
			out.WriteByte('\n')
		default:
			// URI 行：可能是 v_n.m3u8 或 v_n_00001.ts，统一重新签名
			out.WriteString(signFn(trimmed))
			out.WriteByte('\n')
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
