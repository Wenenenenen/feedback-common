/* 三对三匹配调试台 — 无构建步骤，直接操作 HTTP 接口。 */
"use strict";

const REGIONS = ["r1", "r2", "r3"];

/** Unique request keys so a double click never replays a stale result. */
let keyCounter = 0;
function newKey(prefix) {
  keyCounter += 1;
  const stamp = Date.now().toString(36);
  return `${prefix}-${stamp}-${keyCounter}`;
}

const state = {
  clock: 0,
  tickets: [],
  rooms: [],
  counts: {},
  previewNow: null,
  diagnosis: null,
  candidates: [],
  loading: false,
};

/* ---------- DOM helpers ---------- */

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else if (key === "dataset") Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

let bannerTimer = null;
function banner(message, kind = "info", sticky = false) {
  const node = $("banner");
  node.textContent = message;
  node.className = `banner ${kind}`;
  node.hidden = false;
  if (bannerTimer) clearTimeout(bannerTimer);
  if (!sticky) bannerTimer = setTimeout(hideBanner, 6000);
}
function hideBanner() {
  $("banner").hidden = true;
}

/* ---------- HTTP ---------- */

async function call(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    throw new Error(`网络错误: ${error.message}`);
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  return { status: response.status, ok: response.ok, body: data };
}

function describeError(body) {
  if (!body || !body.error) return "未知错误";
  const { code, message, details } = body.error;
  let text = `[${code}] ${message}`;
  if (details !== undefined) text += `\n${JSON.stringify(details, null, 2)}`;
  return text;
}

/* ---------- rendering: queue ---------- */

function pingSummary(ping) {
  const parts = REGIONS.filter((region) => ping[region] !== undefined).map(
    (region) => `${region}:${ping[region]}`
  );
  return parts.length ? parts.join(" ") : "无可用地区";
}

function renderMembers(members) {
  return el(
    "div",
    { class: "members" },
    members.map((member) =>
      el(
        "span",
        { class: "member", title: `技能 ${member.skill} · ${pingSummary(member.ping)}` },
        el("span", { text: member.id }),
        el("span", { class: "skill", text: `S${member.skill}` }),
        el("span", { class: "ping", text: pingSummary(member.ping) })
      )
    )
  );
}

function renderTickets() {
  const list = $("ticket-list");
  list.replaceChildren();
  const tickets = [...state.tickets].sort((a, b) => {
    const rank = { queued: 0, matched: 1, cancelled: 2 };
    const byStatus = (rank[a.status] ?? 3) - (rank[b.status] ?? 3);
    if (byStatus !== 0) return byStatus;
    return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
  });

  if (!tickets.length) {
    list.append(el("p", { class: "empty", text: "队列为空。在右侧编辑票据并点「入队」。" }));
    return;
  }

  for (const ticket of tickets) {
    const isQueued = ticket.status === "queued";
    const head = el(
      "div",
      { class: "ticket-head" },
      el("span", { class: "ticket-id", text: ticket.id }),
      el("span", { class: `badge ${ticket.status}`, text: ticket.status }),
      ticket.status === "matched" && ticket.roomId
        ? el("span", { class: "chip region", text: `房间 #${ticket.roomId}` })
        : null,
      el("span", {
        class: "ticket-meta",
        text: `${ticket.memberCount} 人 · createdAt ${ticket.createdAt}ms`,
      }),
      isQueued
        ? el("button", {
            class: "small danger",
            text: "取消",
            onclick: () => cancelTicket(ticket.id),
          })
        : null,
      isQueued
        ? el("button", {
            class: "small ghost",
            text: "填入编辑器",
            onclick: () => fillEditor(ticket),
          })
        : null,
      isQueued ? el("button", {
        class: "small ghost",
        dataset: { raceTicket: ticket.id },
        title: "填入并发实验的 ticketId",
        text: "选为并发目标",
        onclick: () => { $("race-ticket").value = ticket.id; },
      }) : null,
      isQueued ? el("button", {
        class: "small ghost",
        text: "并入队副本",
        title: "用新的 ticketId 复制这张票",
        onclick: () => fillEditor(ticket, true),
      }) : null
    );
    list.append(
      el("div", { class: `ticket ${ticket.status}` }, head, renderMembers(ticket.members))
    );
  }
}

/* ---------- rendering: candidates ---------- */

function renderCandidates() {
  const host = $("candidates");
  host.replaceChildren();
  const candidates = state.candidates || [];

  if (!candidates.length) {
    host.append(
      el("p", {
        class: "empty",
        text: "当前没有合法候选。下方「淘汰原因」说明每个六人组合卡在哪一步。",
      })
    );
    return;
  }

  candidates.forEach((candidate, position) => {
    const best = position === 0 && candidate.index === 0;
    const head = el(
      "div",
      { class: "candidate-head" },
      el("span", { class: "rank", text: `#${candidate.index + 1}` }),
      el("span", { class: "cand-tickets", text: candidate.ticketIds.join(" + ") }),
      el("span", { class: "chip region", text: candidate.region }),
      el("span", { class: "chip diff", text: `实力差 ${candidate.skillDifference}` }),
      el("span", { class: "chip ping", text: `最大延迟 ${candidate.maxPing}ms` }),
      best ? el("span", { class: "chip", text: "本轮首选" }) : null
    );

    const teamA = el(
      "div",
      { class: "team a" },
      el("div", { class: "team-label", text: `A 队 · 总分 ${candidate.skillA}` }),
      renderMembers(membersByIds(candidate.teamA, candidate.members))
    );
    const teamB = el(
      "div",
      { class: "team b" },
      el("div", { class: "team-label", text: `B 队 · 总分 ${candidate.skillB}` }),
      renderMembers(membersByIds(candidate.teamB, candidate.members))
    );

    const key = candidate.sortKey;
    const keyLine = el(
      "div",
      { class: "sortkey" },
      el("b", { text: "排序键 " }),
      `票序 ${JSON.stringify(key[0])} · 分差 ${key[1]} · 延迟 ${key[2]}ms · ` +
        `地区 ${key[3]} · A ${JSON.stringify(key[4])} · B ${JSON.stringify(key[5])}`
    );

    host.append(
      el(
        "div",
        { class: `candidate${best ? " best" : ""}` },
        head,
        el("div", { class: "teams" }, teamA, el("div", { class: "vs", text: "VS" }), teamB),
        keyLine
      )
    );
  });
}

/**
 * Member lookup that also uses the room/candidate's own embedded member list,
 * so historical rooms (whose tickets may be filtered from the queue view) still
 * render their players.
 */
function membersByIds(ids, embedded) {
  const index = new Map();
  for (const ticket of state.tickets) {
    for (const member of ticket.members) index.set(member.id, member);
  }
  for (const member of embedded || []) index.set(member.id, member);
  return ids.map((id) => index.get(id) || { id, skill: "?", ping: {} });
}

/* ---------- rendering: diagnosis ---------- */

function renderDiagnosis() {
  const host = $("diagnosis");
  host.replaceChildren();
  const diag = state.diagnosis;
  if (!diag) return;

  const blocking = Object.keys(diag.blockingReasons || {});
  const summary = diag.truncated
    ? `扫描了 ${diag.scannedCombinations} 个组合（已达上限，结果可能不完整）`
    : `扫描了 ${diag.scannedCombinations} 个六人票组合，其中 ${diag.validCombinations} 个合法`;
  host.append(
    el("div", { class: "diag-title", text: `淘汰原因 · now=${diag.now}ms · ${summary}` })
  );

  const cards = el("div", { class: "diag-grid" });
  const order = ["insufficient_players", "party_unsplittable", "skill_spread_exceeded", "no_common_region"];
  for (const code of order) {
    const bucket = (diag.reasons || {})[code];
    if (!bucket) continue;
    const isBlocking = bucket.count > 0;
    const card = el("div", { class: `diag-card${isBlocking ? " blocking" : ""}` });
    card.append(
      el("div", { class: "n", text: String(bucket.count) }),
      el("div", { class: "label", text: bucket.label }),
      el("div", { class: "code", text: code })
    );
    if (bucket.examples && bucket.examples.length) {
      card.append(
        el(
          "ul",
          {},
          bucket.examples.slice(0, 3).map((example) =>
            el("li", {
              text: `${example.ticketIds.join("+")} — ${example.detail}`,
            })
          )
        )
      );
    }
    cards.append(card);
  }
  host.append(cards);

  if (!blocking.length && diag.validCombinations > 0) {
    host.append(
      el("p", {
        class: "diag-summary",
        style: { marginTop: "8px" },
        text: "所有六人组合均合法，推进匹配即可分房。",
      })
    );
  }
}

/* ---------- rendering: rooms ---------- */

function renderRooms() {
  const host = $("rooms");
  host.replaceChildren();
  if (!state.rooms.length) {
    host.append(el("p", { class: "empty", text: "还没有房间。点击顶部「推进匹配」。" }));
    return;
  }
  for (const room of [...state.rooms].reverse()) {
    const teams = room.teams || {};
    host.append(
      el(
        "div",
        { class: "room" },
        el(
          "div",
          { class: "room-head" },
          el("span", { class: "room-id", text: `房间 #${room.roomId}` }),
          el("span", { class: "chip region", text: room.region }),
          el("span", { class: "chip diff", text: `实力差 ${room.skillDifference}` }),
          el("span", { class: "chip ping", text: `最大延迟 ${room.maxPing}ms` }),
          el("span", { class: "ticket-meta", text: `tick@${room.clock}ms` })
        ),
        el(
          "div",
          { class: "teams" },
          el(
            "div",
            { class: "team a" },
            el("div", { class: "team-label", text: `A 队 · ${(teams.A?.ticketIds || []).join(" + ")}` }),
            renderMembers(membersByIds(room.teamA, room.members))
          ),
          el("div", { class: "vs", text: "VS" }),
          el(
            "div",
            { class: "team b" },
            el("div", { class: "team-label", text: `B 队 · ${(teams.B?.ticketIds || []).join(" + ")}` }),
            renderMembers(membersByIds(room.teamB, room.members))
          )
        )
      )
    );
  }
}

/* ---------- rendering: requests ---------- */

async function renderRequests() {
  const host = $("requests");
  const result = await call("GET", "/requests?limit=30");
  host.replaceChildren();
  if (!result.ok) {
    host.append(el("p", { class: "empty", text: describeError(result.body) }));
    return;
  }
  const rows = result.body.requests || [];
  if (!rows.length) {
    host.append(el("p", { class: "empty", text: "还没有写请求。" }));
    return;
  }
  for (const row of rows) {
    const payload = row.payload || {};
    let summary = "";
    if (row.path === "/tickets") summary = `${payload.id} · ${(payload.members || []).length} 人`;
    else if (row.path === "/cancel") summary = `ticketId=${payload.ticketId}`;
    else if (row.path === "/tick") summary = `now=${payload.now}`;
    else summary = JSON.stringify(payload).slice(0, 80);

    const node = el(
      "div",
      { class: "request", title: "点击重放该请求（同键同载荷应返回原结果）" },
      el("span", { class: "key", text: row.requestKey }),
      el("span", { class: "path", text: `${row.method} ${row.path}` }),
      el("span", { class: "status", text: String(row.status) }),
      el("span", { class: "payload", text: summary })
    );
    node.addEventListener("click", () => replayRequest(row));
    host.append(node);
  }
}

async function replayRequest(row) {
  const result = await call("GET", `/requests/${encodeURIComponent(row.requestKey)}`);
  if (!result.ok) {
    banner(describeError(result.body), "err");
    return;
  }
  banner(
    `重放 ${row.requestKey}：原结果已永久保留。\n${JSON.stringify(result.body.result, null, 2)}`,
    "info",
    true
  );
}

/* ---------- data refresh ---------- */

function renderStats() {
  const counts = state.counts || {};
  $("stat-clock").textContent = `${state.clock}`;
  $("stat-queued").textContent = `${counts.queued ?? 0}/${counts.queueCapacity ?? 24}`;
  $("stat-members").textContent = `${counts.queuedMembers ?? 0}`;
  $("stat-rooms").textContent = `${state.rooms.length}`;
  $("queue-hint").textContent =
    `排队 ${counts.queued ?? 0} 张 · 已分房 ${counts.matched ?? 0} · 已取消 ${counts.cancelled ?? 0}`;
  const tickInput = $("tick-now");
  if (document.activeElement !== tickInput && Number(tickInput.value) < state.clock) {
    tickInput.value = state.clock;
  }
  if (!tickInput.value) tickInput.value = state.clock;
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  try {
    const [stateResult, debugResult] = await Promise.all([
      call("GET", "/state"),
      call("GET", debugQuery()),
    ]);
    if (!stateResult.ok) throw new Error(describeError(stateResult.body));
    state.clock = stateResult.body.clock;
    state.tickets = stateResult.body.tickets;
    state.rooms = stateResult.body.rooms;
    state.counts = stateResult.body.counts;

    if (debugResult.ok) {
      state.candidates = debugResult.body.candidates;
      state.diagnosis = debugResult.body.diagnosis;
    } else {
      state.candidates = [];
      state.diagnosis = null;
    }

    renderStats();
    renderTickets();
    renderCandidates();
    renderDiagnosis();
    renderRooms();
    renderRequests();
  } catch (error) {
    banner(`刷新失败：${error.message}`, "err");
  } finally {
    state.loading = false;
  }
}

function debugQuery() {
  const raw = $("preview-now").value.trim();
  const params = new URLSearchParams({ limit: "20" });
  if (raw !== "" && Number.isFinite(Number(raw))) params.set("now", String(Number(raw)));
  return `/debug/candidates?${params.toString()}`;
}

/* ---------- actions ---------- */

async function post(path, body, successMessage) {
  const result = await call("POST", path, body);
  if (!result.ok) {
    banner(describeError(result.body), "err", true);
    await refresh();
    return result;
  }
  if (successMessage) banner(successMessage(result.body), "ok");
  await refresh();
  return result;
}

async function cancelTicket(ticketId) {
  await post(
    "/cancel",
    { requestKey: newKey("cancel"), ticketId },
    (body) =>
      body.alreadyCancelled
        ? `票 ${ticketId} 早已取消，返回原取消终态（cancelledBy=${body.cancelledBy}）`
        : `已取消票 ${ticketId}`
  );
}

async function doTick(now) {
  const result = await post(
    "/tick",
    { requestKey: newKey("tick"), now },
    (body) =>
      body.roomsCreated.length
        ? `推进到 ${now}ms：新建 ${body.roomsCreated.length} 个房间（#${body.roomIds.join(", #")}）`
        : `推进到 ${now}ms：没有满足条件的六人组合`
  );
  if (result.ok) {
    $("tick-now").value = Math.max(Number($("tick-now").value) || 0, now);
  }
}

async function raceCancelAndTick(ticketId) {
  const now = Math.max(Number($("tick-now").value) || 0, state.clock);
  const out = $("race-result");
  out.hidden = false;
  out.textContent = "同时发出取消与推进…";

  const cancelKey = newKey("race-cancel");
  const tickKey = newKey("race-tick");
  const [cancelResult, tickResult] = await Promise.all([
    call("POST", "/cancel", { requestKey: cancelKey, ticketId }),
    call("POST", "/tick", { requestKey: tickKey, now }),
  ]);

  const lines = [
    `ticketId = ${ticketId} · now = ${now}ms`,
    `取消  ${cancelResult.status}  ${
      cancelResult.ok ? "成功（先提交）" : describeError(cancelResult.body).split("\n")[0]
    }`,
    `推进  ${tickResult.status}  ${
      tickResult.ok
        ? `房间 ${tickResult.body.roomIds.length ? "#" + tickResult.body.roomIds.join(", #") : "无"}`
        : describeError(tickResult.body).split("\n")[0]
    }`,
  ];
  out.textContent = lines.join("\n");

  if (tickResult.ok) {
    const stateResult = await call("GET", "/state");
    if (stateResult.ok) {
      const ticket = stateResult.body.tickets.find((item) => item.id === ticketId);
      const room = (stateResult.body.rooms || []).find((item) =>
        [...item.teamA, ...item.teamB].some((memberId) =>
          (ticket?.members || []).some((member) => member.id === memberId)
        )
      );
      out.textContent +=
        `\n\n终态  status=${ticket?.status ?? "?"}  roomId=${ticket?.roomId ?? "—"}` +
        `\n房间  ${room ? "#" + room.roomId + " " + room.ticketIds.join(" + ") : "无"}`;
    }
  }
  await refresh();
}

/* ---------- editor ---------- */

function memberRow(member = { id: "", skill: 100, ping: { r1: 20, r2: 30, r3: "" } }) {
  const row = el("div", { class: "member-row" });
  const idInput = el("input", { placeholder: "玩家 id", value: member.id || "" });
  const skillInput = el("input", {
    type: "number",
    step: "1",
    value: member.skill ?? 100,
    title: "skill",
  });
  const pingInputs = {};
  for (const region of REGIONS) {
    const value = member.ping && member.ping[region];
    const input = el("input", {
      type: "number",
      min: "0",
      step: "1",
      placeholder: region,
      value: value === undefined || value === null ? "" : value,
      title: `ping.${region}（留空 = 不可用）`,
    });
    pingInputs[region] = input;
    row.append(
      el("label", { class: "field" }, el("span", { text: region }), input)
    );
  }
  const remove = el("button", {
    class: "ghost danger small remove",
    type: "button",
    text: "移除",
    onclick: () => {
      if ($("member-rows").children.length > 1) row.remove();
    },
  });
  row.prepend(
    el(
      "label",
      { class: "field" },
      el("span", { text: "玩家 id" }),
      idInput
    ),
    el("label", { class: "field" }, el("span", { text: "skill" }), skillInput)
  );
  row.append(remove);
  row._read = () => {
    const ping = {};
    for (const region of REGIONS) {
      const raw = pingInputs[region].value.trim();
      if (raw === "") continue;
      ping[region] = Number(raw);
    }
    return {
      id: idInput.value.trim(),
      skill: Number(skillInput.value),
      ping,
    };
  };
  return row;
}

function addMemberRow(member) {
  $("member-rows").append(memberRow(member));
}

function fillEditor(ticket, copy = false) {
  $("draft-id").value = copy ? nextCopyId(ticket.id) : ticket.id;
  const rows = $("member-rows");
  rows.replaceChildren();
  ticket.members.forEach((member) =>
    addMemberRow({ id: member.id, skill: member.skill, ping: member.ping })
  );
  banner(copy ? "已复制到编辑器（请修改 ticketId 与成员）" : `已载入 ${ticket.id}`, "info");
}

function nextCopyId(base) {
  const used = new Set(state.tickets.map((ticket) => ticket.id));
  let index = 1;
  let candidate = `${base}-copy`;
  while (used.has(candidate)) candidate = `${base}-copy${++index}`;
  return candidate;
}

async function joinDraft() {
  const ticketId = $("draft-id").value.trim();
  if (!ticketId) {
    banner("请填写 ticketId", "err");
    $("draft-id").focus();
    return;
  }
  const members = [...$("member-rows").children].map((row) => row._read());
  if (!members.length) {
    banner("至少需要 1 名成员", "err");
    return;
  }
  for (const [index, member] of members.entries()) {
    if (!member.id) {
      banner(`第 ${index + 1} 名成员缺少 id`, "err");
      return;
    }
  }
  const result = await post(
    "/tickets",
    { requestKey: newKey("join"), id: ticketId, members },
    (body) => `已入队 ${body.ticket.id}（createdAt=${body.ticket.createdAt}ms，队列 ${body.queueSize} 张）`
  );
  if (result.ok) {
    $("draft-id").value = "";
    const rows = $("member-rows");
    rows.replaceChildren();
    addMemberRow();
  }
}

/* ---------- wiring ---------- */

function init() {
  addMemberRow();
  addMemberRow();
  addMemberRow();

  $("btn-add-member").addEventListener("click", () => {
    if ($("member-rows").children.length >= 3) {
      banner("每张票最多 3 名成员", "info");
      return;
    }
    addMemberRow();
  });
  $("btn-join").addEventListener("click", joinDraft);
  $("btn-refresh").addEventListener("click", refresh);
  $("preview-now").addEventListener("change", refresh);
  $("preview-now").addEventListener("input", debounce(refresh, 250));

  $("btn-tick").addEventListener("click", () => {
    const now = Number($("tick-now").value);
    if (!Number.isFinite(now) || now < 0) {
      banner("推进时间必须是非负整数毫秒", "err");
      return;
    }
    doTick(Math.floor(now));
  });
  $("btn-tick-5s").addEventListener("click", () => {
    const base = Math.max(Number($("tick-now").value) || 0, state.clock);
    $("tick-now").value = base + 5000;
    doTick(base + 5000);
  });
  $("btn-reset").addEventListener("click", async () => {
    if (!confirm("确定清空所有票、房间与请求记录？此操作不可撤销。")) return;
    const result = await call("POST", "/admin/reset", { requestKey: newKey("reset") });
    if (!result.ok) {
      banner(describeError(result.body), "err", true);
      return;
    }
    banner("已重置", "ok");
    await refresh();
  });
  $("btn-race").addEventListener("click", () => {
    const ticketId = $("race-ticket").value.trim();
    if (!ticketId) {
      banner("请填写要竞争的 ticketId", "err");
      return;
    }
    raceCancelAndTick(ticketId);
  });
  refresh();
  setInterval(refresh, 5000);
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
