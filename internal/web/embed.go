// Package web 通过 go:embed 把前端页面与静态资源（含本地 vendor 的 hls.js）打进单一二进制，运行期零公网依赖。
package web

import "embed"

// Assets 嵌入 web 目录下的全部文件（HTML、JS、CSS、vendor）。
//
//go:embed all:assets
var Assets embed.FS
