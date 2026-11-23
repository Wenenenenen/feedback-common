package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"zonehandoff/internal/engine"
)

// The web page is embedded and served at /; the API stays JSON.
func TestIndexIsServed(t *testing.T) {
	dir := t.TempDir()
	eng, info, err := engine.Open(dir+"/j.wal", base)
	if err != nil {
		t.Fatal(err)
	}
	defer eng.Close()
	ts := httptest.NewServer(New(eng, info, Options{Baseline: base}).Handler())
	defer ts.Close()

	res, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	page := string(raw)
	if res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/html") {
		t.Fatalf("status=%d ct=%s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	for _, want := range []string{"跨区演练台", "btnAction", "btnBegin", "btnCommit", "data-crash"} {
		if !strings.Contains(page, want) {
			t.Fatalf("page missing %q", want)
		}
	}
	// Unknown paths are 404, not the page.
	if r, err := http.Get(ts.URL + "/nope"); err == nil {
		defer r.Body.Close()
		if r.StatusCode != 404 {
			t.Fatalf("unknown path status %d", r.StatusCode)
		}
	}
}

func TestAPIMethodAndBodyValidation(t *testing.T) {
	dir := t.TempDir()
	eng, info, err := engine.Open(dir+"/j.wal", base)
	if err != nil {
		t.Fatal(err)
	}
	defer eng.Close()
	ts := httptest.NewServer(New(eng, info, Options{Baseline: base}).Handler())
	defer ts.Close()

	res, _ := http.Get(ts.URL + "/api/action")
	res.Body.Close()
	if res.StatusCode != 405 {
		t.Fatalf("GET /api/action = %d, want 405", res.StatusCode)
	}
	res, err = http.Post(ts.URL+"/api/action", "application/json", strings.NewReader("{oops"))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("bad json = %d, want 400", res.StatusCode)
	}
	res, err = http.Post(ts.URL+"/api/batch", "application/json", strings.NewReader(`{"items":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("empty batch = %d, want 400", res.StatusCode)
	}
}
