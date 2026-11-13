package sign

import (
	"net/url"
	"testing"
	"time"
)

func TestSignAndVerify(t *testing.T) {
	s, err := New([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("创建 Signer 失败: %v", err)
	}
	path := "/hls/v/abc-123/master.m3u8"
	signed := s.SignURL(path, time.Hour)

	u, _ := url.Parse(signed)
	if err := s.Verify(u.Path, u.Query()); err != nil {
		t.Fatalf("合法签名校验失败: %v", err)
	}
}

func TestVerify_TamperedPath(t *testing.T) {
	s, _ := New([]byte("0123456789abcdef0123456789abcdef"))
	signed := s.SignURL("/hls/v/aaa/master.m3u8", time.Hour)
	u, _ := url.Parse(signed)

	// 路径被换成另一个资源，签名必须不匹配
	err := s.Verify("/hls/v/bbb/master.m3u8", u.Query())
	if err == nil {
		t.Fatal("篡改路径后应当校验失败，但通过了")
	}
}

func TestVerify_MissingParams(t *testing.T) {
	s, _ := New([]byte("0123456789abcdef0123456789abcdef"))
	if err := s.Verify("/hls/v/a/master.m3u8", url.Values{}); err == nil {
		t.Fatal("缺少签名参数应当失败")
	}
}

func TestVerify_Expired(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	s, _ := New(key)
	// 用一个固定的过去时间生成过期签名
	signed := s.SignURL("/hls/v/a/master.m3u8", -time.Minute)
	u, _ := url.Parse(signed)
	err := s.Verify(u.Path, u.Query())
	if err != ErrExpired {
		t.Fatalf("过期签名应返回 ErrExpired，实际: %v", err)
	}
}

func TestVerify_DifferentKeys(t *testing.T) {
	s1, _ := New([]byte("0123456789abcdef0123456789abcdef"))
	s2, _ := New([]byte("fedcba9876543210fedcba9876543210"))
	signed := s1.SignURL("/hls/v/a/master.m3u8", time.Hour)
	u, _ := url.Parse(signed)
	if err := s2.Verify(u.Path, u.Query()); err == nil {
		t.Fatal("不同密钥签发的签名应当校验失败")
	}
}
