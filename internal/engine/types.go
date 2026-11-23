package engine

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// Snapshot is the client-visible state of one entity after an operation.
type Snapshot struct {
	ID     string `json:"id"`
	Zone   string `json:"zone"`
	Epoch  uint64 `json:"epoch"`
	Seq    uint64 `json:"seq"`
	Value  int64  `json:"value"`
	Frozen bool   `json:"frozen"`
	Move   string `json:"move,omitempty"`
}

// ActionReply is returned for an accepted or replayed action.
type ActionReply struct {
	Op     string   `json:"op"`
	ID     string   `json:"id"`
	Seq    uint64   `json:"seq"`
	Zone   string   `json:"zone"`
	Epoch  uint64   `json:"epoch"`
	Delta  int64    `json:"delta"`
	Value  int64    `json:"value"`
	Entity Snapshot `json:"entity"`
}

// MoveView describes a handoff in a reply or in state listings.
type MoveView struct {
	ID     string `json:"id"`
	Entity string `json:"entity"`
	From   string `json:"from"`
	To     string `json:"to"`
	Status string `json:"status"`
}

// StepReply is returned for begin/confirm/commit/abort.
type StepReply struct {
	Op     string   `json:"op"`
	Entity Snapshot `json:"entity"`
	Move   MoveView `json:"move"`
}

// Record is one durable WAL frame. Resp stores the exact reply bytes so a
// retry returns byte-identical output, even across a restart.
type Record struct {
	Op     string          `json:"op"`
	TS     int64           `json:"ts"`
	ID     string          `json:"id,omitempty"`
	Seq    uint64          `json:"seq,omitempty"`
	Delta  int64           `json:"delta,omitempty"`
	Zone   string          `json:"zone,omitempty"`
	Epoch  uint64          `json:"epoch,omitempty"`
	Value  int64           `json:"value,omitempty"`
	Move   string          `json:"move,omitempty"`
	From   string          `json:"from,omitempty"`
	To     string          `json:"to,omitempty"`
	Status string          `json:"status,omitempty"`
	Resp   json.RawMessage `json:"resp,omitempty"`
	// WS is the journal writer sequence that made this record durable. It is
	// never serialized; replay sets it to 0 (already durable).
	WS uint64 `json:"-"`
}

// Error is an operation failure with a machine-readable code.
type Error struct {
	Status    int    `json:"-"`
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
	// ExpectedSeq is set for entity_frozen so a client knows what to retry.
	ExpectedSeq uint64    `json:"expected_seq,omitempty"`
	Entity      *Snapshot `json:"entity,omitempty"`
}

func (e *Error) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Message) }

func newErr(status int, code, msg string) *Error {
	return &Error{Status: status, Code: code, Message: msg}
}
func errBadRequest(msg string) *Error { return newErr(http.StatusBadRequest, "bad_request", msg) }
func errNotFound(msg string) *Error   { return newErr(http.StatusNotFound, "not_found", msg) }
func errConflict(code, msg string) *Error {
	return newErr(http.StatusConflict, code, msg)
}
func errInternal(msg string) *Error {
	return newErr(http.StatusInternalServerError, "internal", msg)
}

// Req is the input accepted by every operation.
type Req struct {
	Op    string `json:"op"`
	ID    string `json:"id"`
	Zone  string `json:"zone"`
	Epoch uint64 `json:"epoch"`
	Seq   uint64 `json:"seq"`
	Delta int64  `json:"delta"`
	Move  string `json:"move"`
	To    string `json:"to"`
	// ItemsRaw carries the raw items array for op=batch.
	ItemsRaw json.RawMessage `json:"items"`
}

func nowMillis() int64 { return time.Now().UnixMilli() }
