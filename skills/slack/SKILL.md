---
name: slack
description: Read and act in the user's Slack web app with da-browser's browser_* tools. Use for "check my Slack", "what's unread", "any mentions", "summarise #channel", "search Slack for", "who said", "find the thread about", or "send/reply/post in Slack". Reads the sidebar, messages, threads, search, and Activity as compact JSON, and sends only after a guarded composer check.
compatibility: Needs the da-browser extension (this package) and Slack signed in at app.slack.com in the CDP-connected Arc/Chromium. The Slack desktop app is not reachable.
---

# Slack

Drive `app.slack.com` in the user's signed-in browser. Extract with `browser_eval` against Slack's own `data-qa` hooks. They hold steadier than `@eN` refs and cost far less than a snapshot of Slack's accessibility tree. Selectors were verified against the live web app on 2026-09-29. If one stops matching, run the discovery snippet under [Troubleshooting](#troubleshooting) and fix this file.

Placeholders: `TEAM` is the team id (`T…`), `CID` a conversation id (`C…` channel, `D…` DM, `G…` group), `TS` a message timestamp like `1788272266.312969`.

## Rules

- **Look before you open.** Opening a channel, DM, or thread marks it read. Answer "what's unread" from the sidebar, Activity, or search, which leave conversations unopened. Open only what the user asked about. Before opening, warn them if it would clear unreads they may want to keep.
- **Sending posts as the user.** Send only text the user wrote, or a draft they approved word for word, and only to the destination they named. Always follow [Send or reply](#send-or-reply). Don't react, edit, delete, join, leave, or change status unless asked.
- **Never touch the user's draft.** If the composer already has text, it's their unsent draft. Stop and ask. Don't clear it or append to it.
- **Verify location by id, never by URL or title.** `document.title` lags after navigation. The URL can read `/dms` or `/activity-inbox` instead of the conversation id. Trust the composer's `data-channel-id` and the messages' `data-msg-channel-id`.
- **Keep context small.** Pass `resnapshot: false` to `browser_find` and prefer these snippets over `browser_snapshot`.
- `browser_click` and `browser_fill` only take `@eN` refs. To act on a CSS selector, use `browser_find` with `locator: "first"`.

## Connect

1. `browser_status`. If it isn't connected, run `browser_connect`.
2. `browser_open` `https://app.slack.com/client` with `waitMode: "load"`.
3. `browser_wait` with `selector: "[data-qa=tab_rail_home_button]"` and `timeoutMs: 45000`. If it lands on a sign-in page or workspace picker, stop and ask the user to sign in. Never type credentials.
4. Slack reopens whichever tab was used last, and the sidebar only renders on Home. If `[data-qa=channel-sidebar]` is missing, run `browser_find` with `locator: "first"`, `value: "[data-qa=tab_rail_home_button]"`, `action: "click"`, `waitMode: "none"`, `resnapshot: false`. Then `browser_wait` with `selector: "[data-qa=channel-sidebar]"`. Finish on Home so the user's Slack reopens there too.
5. Get `TEAM` from `location.pathname.split('/')[2]`. Conversation URLs are `https://app.slack.com/client/TEAM/CID`.

## Map

| Thing | Selector and attributes |
| --- | --- |
| Sidebar row | `[data-qa=channel-sidebar-channel]`. Attributes: `data-qa-channel-sidebar-channel-id`, `…-channel-type` (`channel` `private` `im` `mpim`), `…-channel-is-muted`. Unread rows add the class `p-channel_sidebar__channel--unread` |
| Tabs | `[data-qa=tab_rail_home_button]`, `…_dms_button`, `…_activity_button`, `…_later_button` |
| Conversation header | `[data-qa=channel_name]` |
| Messages | `[data-qa=message_pane]`, or `[data-qa=threads_flexpane]` for an open thread. Each message is a `[data-qa=message_container]` with `data-msg-ts` and `data-msg-channel-id` |
| Composer | `[data-qa=message_input]` with `data-channel-id`, `data-view-context` (`Channel` or `Thread`), and `data-thread-ts`. The editor is its `[contenteditable=true]` child |
| Search | `[data-qa=top_nav_search]`. Results render in `[data-qa=search_view]` as `[data-qa=search_result]` rows |
| Activity | `/client/TEAM/activity-inbox`. Tabs are `[data-qa=activity-saved-view-tab-mentions]` (plus `-all`, `-dms`, `-threads`). Rows are `[data-qa=activity-item-container]` |

## Unreads

Run with `browser_eval`. It doesn't navigate and marks nothing read.

```js
(() => [...document.querySelectorAll('[data-qa=channel-sidebar-channel].p-channel_sidebar__channel--unread')].map((row) => ({
  id: row.dataset.qaChannelSidebarChannelId,
  type: row.dataset.qaChannelSidebarChannelType,
  name: row.querySelector('.p-channel_sidebar__name')?.innerText,
  badge: Number(row.querySelector('[data-qa=sidebar-channel-suffix]')?.innerText.match(/\d+/)?.[0] ?? 0),
  muted: row.dataset.qaChannelSidebarChannelIsMuted === 'true',
})))()
```

Report DMs (`im`, `mpim`) and rows with a `badge` (mention count) first, then channels. Leave out muted rows unless asked. To get the text of mentions and thread replies, use [Activity](#activity). Don't open each channel.

## Open a conversation

When you know the id (from unreads, search, or a link):

1. If the conversation is in the sidebar, run `browser_find` with `locator: "first"`, `value: "[data-qa-channel-sidebar-channel-id=CID]"`, `action: "click"`, `waitMode: "none"`, `resnapshot: false`. This navigates instantly inside the app. If it isn't in the sidebar, `browser_open` `https://app.slack.com/client/TEAM/CID` with `waitMode: "load"`. That's a full reload, so it's slower.
2. `browser_wait` with `fn: "!!document.querySelector('[data-qa=message_pane] [data-msg-channel-id=CID], [data-qa=message_input][data-channel-id=CID]')"`.

When you only have a name (channel or person):

1. `browser_press` `Meta+k` opens the switcher.
2. `browser_command` `["keyboard", "type", "<name>"]`.
3. `browser_press` `ArrowDown`, then run the [active option](#active-option) snippet. Enter opens whatever is highlighted, so press `Enter` only once it shows the right entity. The self-DM row reads `Name(you)`.
4. `browser_wait` until `[data-qa=channel_name]` shows the name. Then read `CID` with `browser_eval`: `document.querySelector('[data-qa=message_input]:not([data-thread-ts])')?.dataset.channelId ?? document.querySelector('[data-qa=message_pane] [data-msg-channel-id]')?.dataset.msgChannelId`. Slack may open a DM in the DMs tab. Return to Home when you're done.

Some app DMs, such as Slackbot, have no composer. That's expected.

### Active option

```js
(() => {
  const option = document.getElementById(document.activeElement?.getAttribute('aria-activedescendant') ?? '');
  if (!option) return 'none';
  return option.querySelector('[data-qa=search-query-entity-text-content]')
    ? 'SEARCH QUERY'
    : option.innerText.replace(/\s+/g, ' ').slice(0, 80);
})()
```

A modal overlay covers the switcher and search options and intercepts pointer clicks. Pick options only with the arrow keys and Enter.

## Read messages

`ROOT` is `[data-qa=message_pane]` for the conversation, or `[data-qa=threads_flexpane]` for an open thread.

```js
((ROOT) => {
  let sender = null; // follow-up messages omit the name, so carry the last one forward
  return [...document.querySelectorAll(`${ROOT} [data-qa=message_container]`)].map((m) => {
    const name = m.querySelector('[data-qa=message_sender_name]');
    if (name) sender = name.innerText;
    const ts = m.dataset.msgTs;
    return {
      ts,
      at: new Date(Number(ts) * 1000).toISOString(),
      sender,
      text: [...m.querySelectorAll('[data-qa=message-text]')].map((t) => t.innerText).join('\n')
        || m.querySelector('[data-qa=message_content]')?.innerText
        || '',
      replies: m.querySelector('[data-qa=reply_bar_count]')?.innerText ?? null,
      link: m.querySelector('a.c-timestamp')?.href ?? null,
    };
  });
})('[data-qa=message_pane]')
```

The list is virtualized, so only messages near the viewport exist. For older history:

1. `browser_scroll` with `direction: "up"`, `pixels: 3000`, `containerSelector: "[data-qa=message_pane] [data-qa=slack_kit_scrollbar]"`.
2. Re-run the snippet and merge by `ts`.
3. Stop when the oldest `ts` stops changing.

`sender` is `null` when a message's group header has scrolled out of the DOM.

To open a thread from a message with `replies`: a sticky header covers the top rows, so centre the target first.

1. `browser_eval`: `document.querySelector('[data-qa=message_pane] [data-msg-ts="TS"] [data-qa=reply_bar_count]').scrollIntoView({ block: 'center' })`
2. `browser_find` with `locator: "first"`, `value: '[data-qa=message_pane] [data-msg-ts="TS"] [data-qa=reply_bar_count]'`, `action: "click"`, `waitMode: "none"`, `resnapshot: false`.
3. `browser_wait` with `selector: "[data-qa=threads_flexpane] [data-qa=message_container]"`. The URL doesn't change for threads.
4. Read with `ROOT` set to `[data-qa=threads_flexpane]`. Close the thread with `[data-qa=close_flexpane]`.

## Search

Search never opens the conversations it lists, so nothing is marked read. That makes it the way to read recent messages and keep unreads intact, for example `in:#channel after:2026-09-01`.

1. `browser_find` with `locator: "first"`, `value: "[data-qa=top_nav_search]"`, `action: "click"`, `waitMode: "none"`, `resnapshot: false`.
2. `browser_command` `["keyboard", "type", "<query>"]`.
3. `browser_press` `ArrowDown`. Repeat until the [active option](#active-option) snippet returns `SEARCH QUERY`, usually one or two presses. The first rows are channel or person matches, and Enter would open them. Then `browser_press` `Enter`.
4. `browser_wait` with `fn: "!!document.querySelector('[data-qa=search_view] [data-qa=search_result]') && document.querySelector('[data-qa=search_view]').innerText.includes('<query>')"`. The URL stays `/search` and doesn't contain the query.
5. Extract:

```js
(() => [...document.querySelectorAll('[data-qa=search_result]')].map((r) => {
  const stamp = r.querySelector('a.c-timestamp');
  return {
    ts: stamp?.dataset.ts,
    at: stamp?.getAttribute('aria-label'),
    channel: r.querySelector('[data-qa=search_result_channel_name]')?.innerText,
    sender: r.querySelector('[data-qa=message_sender_name]')?.innerText,
    text: r.querySelector('[data-qa=message-text]')?.innerText ?? '',
    link: stamp?.href,
  };
}))()
```

There are 20 results per page. The next page is `[data-qa=c-pagination_page_btn_2]`, and so on. For newest first, use `[data-qa=message_sort_toggle-button]`. Useful modifiers: `in:#channel`, `in:@person`, `from:@person`, `before:`, `after:` and `on:YYYY-MM-DD`, `has:link`, `is:thread`, `"exact phrase"`, `-word`.

## Activity

One feed of mentions, thread replies, and DMs. Viewing it may clear the Activity badge, but it doesn't open any channels.

1. `browser_find` with `locator: "first"`, `value: "[data-qa=tab_rail_activity_button]"`, `action: "click"`, `resnapshot: false`. Do the same for `[data-qa=activity-saved-view-tab-mentions]`, or `-threads`, `-dms`, `-all`.
2. `browser_wait` with `fn: "document.querySelector('[data-qa=activity-saved-view-tab-mentions]')?.getAttribute('aria-selected') === 'true'"`. Use the tab you clicked.
3. Extract. `key` looks like `dm-<id>` or `thread_v2-<channel id>-<ts>`. The list re-renders just after a tab switch, so if you get `[]`, wait a second and run it again.

```js
(() => [...document.querySelectorAll('[data-qa=activity-item-container]')].map((a) => ({
  key: a.closest('[data-qa=virtual-list-item]')?.dataset.itemKey,
  text: a.innerText.replace(/\s+/g, ' ').trim().slice(0, 400),
})))()
```

4. When you're done, go back to Home with `[data-qa=tab_rail_home_button]`. The sidebar needs it, and Slack reopens on the last tab used.

## Send or reply

`BOX` is a composer selector that pins every step to the intended destination:

- Channel or DM: `[data-qa=message_input][data-view-context=Channel][data-channel-id=CID]`
- Thread reply (open the thread first): `[data-qa=message_input][data-view-context=Thread][data-thread-ts="TS"]`

Composer check, run with `browser_eval`:

```js
((BOX, WANT) => {
  const editor = document.querySelector(`${BOX} [contenteditable=true]`);
  if (!editor) return { ok: false, why: 'no composer: wrong conversation, thread not open, or read-only' };
  const text = [...editor.children].map((line) => line.textContent).join('\n');
  return {
    to: editor.getAttribute('aria-label'), // "Message to project-admin", "Reply to thread in project-admin"
    blank: editor.classList.contains('ql-blank'),
    exact: text === WANT,
    focused: editor.contains(document.activeElement),
    alsoSendToChannel: Boolean(document.querySelector('[data-qa=threads_footer_broadcast_checkbox]')?.checked),
    text,
  };
})('BOX', 'WANT')
```

1. Open the conversation, and the thread if you're replying, then wait as above.
2. Run the check. `to` must name the destination the user asked for. Otherwise stop. `blank` must be `true`. Otherwise the composer holds the user's draft, so stop and ask.
3. `browser_find` with `locator: "first"`, `value: "BOX [contenteditable=true]"`, `action: "fill"`, `text: "<message>"`, `resnapshot: false`.
   - Newlines in `text` become line breaks and never send.
   - `fill` appends to existing text, which is why step 2 matters.
   - Don't use `keyboard type` here. A newline would press Enter and send.
4. Run the check again. You need the same `to`, `exact: true`, `focused: true`, and `alsoSendToChannel: false`.
   - If `exact` is false because Slack auto-formatted markdown or an @mention, show the user `text` before you continue.
   - If you abort, clear your own text with the clear snippet so you leave no draft behind.
5. `browser_press` `Enter`.
6. `browser_wait` with `fn: "document.querySelector('BOX [contenteditable=true]')?.classList.contains('ql-blank')"`. Then read the last message with the read snippet (same `ROOT`) and report its `link`. If the composer didn't clear, an autocomplete popup probably took the Enter. Inspect before you press again, so nothing posts twice.

Clear snippet, only for text you inserted yourself:

```js
((BOX) => {
  const editor = document.querySelector(`${BOX} [contenteditable=true]`);
  editor.focus();
  getSelection().selectAllChildren(editor);
  document.execCommand('delete'); // Meta+a does not select-all in Slack's editor over CDP
  return editor.textContent === ''; // ql-blank updates a tick later, so confirm with the composer check
})('BOX')
```

## Troubleshooting

- **A selector matches nothing.** Slack changed its markup. List the live hooks, find the new name, and update this skill:

  ```js
  Object.entries([...document.querySelectorAll('[data-qa]')].reduce((n, e) => ((n[e.dataset.qa] = (n[e.dataset.qa] ?? 0) + 1), n), {}))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 150)
  ```

- **"covered by … at its click point".** A sticky header or a modal is in the way. `scrollIntoView({ block: 'center' })` the target, or `browser_press` `Escape` to close a popup, then retry.
- **`tab_gone`.** The controlled tab was closed. Recover with `browser_tab` `new` or `browser_connect`, then go through [Connect](#connect) again.
- **The user wants proof.** `browser_checkpoint` saves a screenshot and a snapshot as a pair.
