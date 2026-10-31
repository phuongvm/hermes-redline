// Stand-ins for the Desktop plugin SDK surface desktop/plugin.js imports. Components are element
// types only (nothing renders them); host and useQuery are wired so the pane's render path runs.
const query_results = new Map()

export function __setQueryResult(key, value) {
  query_results.set(key, value)
}

export function __reset() {
  query_results.clear()
  host.workspaces.length = 0
  host.submissions.length = 0
  host.errors.length = 0
  host.focusedSessionId = 'test-session'
  host.focusedStoredSessionId = ''
  host.activeSessionId = ''
  host.submitResult = true
}

export const STATUSBAR_AREAS = { right: 'statusbar.right' }
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar.nav'
export const TRANSCRIPT_DIRECTIVE_AREA = 'transcript.directive'

export const Badge = function Badge() {}
export const Button = function Button() {}
export const Codicon = function Codicon() {}
export const Input = function Input() {}
export const MessageTextContent = function MessageTextContent() {}
export const Textarea = function Textarea() {}

export const atom = (initial) => {
  const box = { value: initial, get: () => box.value, set(next) { box.value = next } }
  return box
}
export const queryClient = { setQueryData() {} }
export const useValue = (source) => (source && source.get ? source.get() : 0)

export const useQuery = ({ queryKey }) => ({
  data: query_results.get(queryKey[0]),
  isPending: false,
  isError: false,
})

export const host = {
  workspaces: [],
  submissions: [],
  errors: [],
  focusedSessionId: 'test-session',
  focusedStoredSessionId: '',
  activeSessionId: '',
  submitResult: true,
  notify() {},
  notifyError(message) { host.errors.push(message) },
  composer: { submit: (sessionId, message) => {
    host.submissions.push({ sessionId, message })
    return host.submitResult
  } },
  state: {
    focusedSessionId: { get: () => host.focusedSessionId },
    focusedStoredSessionId: { get: () => host.focusedStoredSessionId },
    activeSessionId: { get: () => host.activeSessionId },
  },
  openWorkspace(_id, options) {
    host.workspaces.push(options)
  },
}
