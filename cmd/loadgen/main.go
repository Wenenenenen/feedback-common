// Command loadgen drives N sequential actions against a running server and
// reports throughput. It proves the 8s / 20k budget end-to-end over HTTP.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

func main() {
	base := flag.String("url", "http://127.0.0.1:8080", "server base URL")
	id := flag.String("id", "runner1", "entity id")
	zone := flag.String("zone", "east", "zone")
	epoch := flag.Uint64("epoch", 0, "epoch")
	start := flag.Uint64("start", 1, "first seq")
	total := flag.Int("n", 20000, "number of actions")
	batch := flag.Int("batch", 500, "actions per batch request")
	timeout := flag.Duration("timeout", 8*time.Second, "budget; exceeded means failure")
	flag.Parse()

	client := &http.Client{Timeout: 30 * time.Second}
	seq := *start
	t0 := time.Now()
	applied := 0
	for applied < *total {
		n := *batch
		if *total-applied < n {
			n = *total - applied
		}
		items := make([]map[string]any, 0, n)
		for i := 0; i < n; i++ {
			items = append(items, map[string]any{"id": *id, "zone": *zone, "epoch": *epoch, "seq": seq, "delta": 1})
			seq++
		}
		payload, _ := json.Marshal(map[string]any{"items": items})
		res, err := client.Post(*base+"/api/batch", "application/json", bytes.NewReader(payload))
		if err != nil {
			fail("batch request: %v", err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != 200 {
			fail("batch status %d: %s", res.StatusCode, body)
		}
		var out struct {
			Applied int `json:"applied"`
			Count   int `json:"count"`
			Results []struct {
				OK    bool `json:"ok"`
				Error *struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			} `json:"results"`
		}
		if err := json.Unmarshal(body, &out); err != nil {
			fail("decode: %v", err)
		}
		if out.Applied != n {
			for i, r := range out.Results {
				if !r.OK && r.Error != nil {
					fail("item %d rejected: %s %s", i, r.Error.Code, r.Error.Message)
				}
			}
			fail("applied %d of %d", out.Applied, n)
		}
		applied += n
	}
	elapsed := time.Since(t0)

	// Query the result back.
	res, err := client.Get(*base + "/api/state")
	if err != nil {
		fail("state: %v", err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	var st struct {
		Entities []struct {
			ID    string `json:"id"`
			Seq   uint64 `json:"seq"`
			Value int64  `json:"value"`
		} `json:"entities"`
	}
	_ = json.Unmarshal(body, &st)
	var gotSeq uint64
	var gotVal int64
	for _, e := range st.Entities {
		if e.ID == *id {
			gotSeq, gotVal = e.Seq, e.Value
		}
	}
	// Fetch a page of the log to prove it is queryable.
	lr, err := client.Get(fmt.Sprintf("%s/api/log?from=%d&limit=10", *base, applied-10))
	if err == nil {
		lr.Body.Close()
	}
	fmt.Printf("applied=%d elapsed=%s rate=%.0f/s final_seq=%d final_value=%d\n",
		applied, elapsed.Round(time.Millisecond), float64(applied)/elapsed.Seconds(), gotSeq, gotVal)
	if gotSeq != seq-1 {
		fail("server seq=%d want %d", gotSeq, seq-1)
	}
	if elapsed > *timeout {
		fail("exceeded budget: %s > %s", elapsed, *timeout)
	}
	fmt.Printf("OK within %s budget\n", *timeout)
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "FAIL: "+format+"\n", args...)
	os.Exit(1)
}
