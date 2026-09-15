/**
 * dsh-tokenrhythm-bill client half: the browser panel, loaded by the web
 * ModuleLoader as a plain React plugin. It injects:
 *   - a self-healing sidebar row (DOM-injected under the 记忆系统 / 技能中心 rows,
 *     because the shell exposes no registerable slot there) labelled 基元费用 with
 *     a persistent balance pill and an amber alert dot when quota is near expiry;
 *   - a draggable/resizable frosted-glass panel (slot `shell.overlay`) with
 *     tabs (余额 / 模型 / 密钥) and a gear in the top-right corner for settings:
 *       余额    — expiring-quota hero, daily usage (incl. cache hits),
 *                 7-day cost sparkline, recent calls list;
 *       模型    — category chips (全部/文本/图像/音频/视频/向量) + model cards;
 *                 click a card to copy its model id; the platform status pill
 *                 comes from the models API itself (no separate probe);
 *       密钥    — local credential pool: save an API key and/or the web session
 *                 cookie as a list entry, click 使用 to make one the active
 *                 credential (its key drives the model list, its cookie drives
 *                 balance/usage) and 删除 to drop it; the active one shows
 *                 「当前」, and entries render their stored values verbatim;
 *       设置    — tokenrhythm account+password pool and session status.
 * The title hosts a provider switcher (基元 | ZCode); the ZCode half shows
 * plan quota (用量) and claimable activities (活动) read from ~/.zcode/v2
 * credentials via the host. Settings opens as a modal over the panel (gear).
 *
 * Host communication is plain HTTP to /dsh-tokenrhythm-bill/* (same origin).
 * Panel geometry persists via the Host's /prefs endpoint. A 5-minute
 * background poll keeps the alert dot fresh even while the panel is closed.
 * The credential list is the only response carrying stored secrets verbatim
 * (the panel shows them so they can be checked); everything else is masked.
 */
window.__ModuleLoader__.load({
  id: 'dsh-tokenrhythm-bill',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    // 侧栏条目需要把 React 挂到注入的 DOM 节点上；拿不到就退回「不注入条目」（面板照常）。
    let ReactDOMClient = null;
    try { ReactDOMClient = require('react-dom/client') } catch { ReactDOMClient = null }
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;
    const useCallback = React.useCallback;

    const API = '/dsh-tokenrhythm-bill';

    // ---- tiny cross-component store（入口按钮与面板分属两个槽位，需要共享状态）。
    // balanceCny 独立于 alert 存放：alert 只在低余额/临期时有值，正常余额时为 null，
    // 入口常驻的总余额不能挂在它上面 ----
    const store = { open: false, view: 'models', alert: null, balanceCny: null, expiringItems: [], entryBalMode: 'total', provider: 'tr', settingsOpen: false, zcEntry: null, zcodeEnabled: false };
    const listeners = new Set();
    const setStore = (patch) => {
      Object.assign(store, patch);
      for (const fn of listeners) { try { fn() } catch { /* 单个订阅者异常不拖垮其它 */ } }
    };
    const useStore = () => {
      const [, force] = useState(0);
      useEffect(() => {
        const fn = () => force((n) => n + 1);
        listeners.add(fn);
        return () => listeners.delete(fn);
      }, []);
      return store;
    };

    // ---- fetch helpers ----
    const jsonGet = async (path) => {
      try {
        const res = await fetch(path, { cache: 'no-store' });
        return await res.json();
      } catch { return null }
    };
    const jsonPost = async (path, body) => {
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return await res.json();
      } catch { return null }
    };

    // ---- 剪贴板 ----
    const copyText = async (text) => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true }
        const ta = document.createElement('textarea')
        ta.value = text
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        return true
      } catch { return false }
    }

    // ---- formatting ----
    const trimNum = (n) => {
      if (n === null || n === undefined || !Number.isFinite(n)) return '—'
      const r = Math.abs(n) >= 100 ? Math.round(n * 10) / 10 : Math.round(n * 1000) / 1000
      return String(r)
    }
    // 主卡金额：≥1000 加千分位（¥1,669.3），其余与 trimNum 口径一致。
    const fmtCny = (n) => {
      if (n === null || n === undefined || !Number.isFinite(n)) return '—'
      if (Math.abs(n) >= 1000) return (Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })
      return trimNum(n)
    }
    const fmtCtx = (n) => {
      if (n === null || n === undefined || !Number.isFinite(n)) return null
      if (n >= 1000000) return trimNum(n / 1000000) + 'M'
      if (n >= 1000) return trimNum(n / 1000) + 'K'
      return String(n)
    }
    // 更新检测时间：今天显示 HH:MM，更早显示 M-D。
    const fmtCheckedAt = (ts) => {
      const d = new Date(ts)
      if (!Number.isFinite(d.getTime())) return ''
      const now = new Date()
      const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
      if (sameDay) return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
      return (d.getMonth() + 1) + '-' + d.getDate()
    }
    const fmtTokens = (n) => {
      if (n === null || n === undefined || !Number.isFinite(n)) return '—'
      if (Math.abs(n) >= 100000000) return trimNum(n / 100000000) + ' 亿'
      if (Math.abs(n) >= 10000) return trimNum(n / 10000) + ' 万'
      return String(Math.round(n))
    }
    // 价格单元格（官方样式）：折扣时划线原价 + 折后现价，¥x.xx/M。
    const priceCell = (base, eff) => {
      const discounted = eff !== null && eff !== undefined && eff !== base
      const cur = discounted ? eff : base
      return React.createElement('span', { className: 'dsh-mb-card-price' },
        discounted ? React.createElement('span', { className: 'dsh-mb-card-price-old' }, '¥' + trimNum(base) + '/M') : null,
        '¥' + cur.toFixed(2) + '/M')
    }
    // 到期天数：按「日历日」算（今天到期 = 0、明天 = 1、已过期 < 0）；缺失/解析失败返回 null。
    // 不用 Math.ceil((t-now)/86400000)：今晚到期会被算成 1 天，胶囊会写成「明天到期 · 今天日期」。
    const expiryDaysOf = (expireAt) => {
      if (expireAt === null || expireAt === undefined) return null
      const t = typeof expireAt === 'number' ? expireAt : Date.parse(expireAt)
      if (!Number.isFinite(t)) return null
      const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }
      return Math.round((dayStart(t) - dayStart(Date.now())) / 86400000)
    }
    // 到期文案：0 → 今天到期、1 → 明天到期、N → N 天后到期、负数 → 已到期。
    // 天数缺失时退「即将到期」——绝不把 undefined / NaN 拼进用户可见文案。
    const expiryLabel = (days) => {
      if (days === null || days === undefined || !Number.isFinite(days)) return '即将到期'
      if (days < 0) return '已到期'
      if (days === 0) return '今天到期'
      if (days === 1) return '明天到期'
      return days + ' 天后到期'
    }
    // 预警判定：临期 ≤3 天且还有限时额度，或可用余额 < ¥10。
    // 字段名必须与读取端（入口 title / 余额横幅）一致：曾写 expDays 而读 expiringDays，
    // 横幅于是渲染成「限时额度 ¥67.986 将于 undefined 天后到期」。已过期（负数）不算临期，
    // 避免对已经作废的额度反复催办。
    const alertOf = (d) => {
      if (!d) return null
      const expiringDays = expiryDaysOf(d.nextExpiryAt)
      const low = d.availableBalanceCny !== null && d.availableBalanceCny !== undefined && d.availableBalanceCny < 10
      const expiring = expiringDays !== null && expiringDays >= 0 && expiringDays <= 3 && (d.expiringBalanceCny || 0) > 0
      if (!low && !expiring) return null
      return { low, expiring, expiringDays, expiringBalanceCny: d.expiringBalanceCny, availableBalanceCny: d.availableBalanceCny }
    }

    // ---- ZCode 入口胶囊仲裁（面板切到「ZCode」→ 胶囊跟随显示套餐剩余）----
    // 数据优先级：有总量 → 剩余百分比（与其它总量类套餐同款口径）；无总量只有余量
    // → token 缩写；无凭证 / 空套餐 / 未选中 → null（胶囊整体回落基元身份）。
    function computeZcEntry({ provider, quota }) {
      if (provider !== 'zcode' || !quota || quota.ok === false) return null
      if (quota.source === 'no_plan' || quota.isEmpty === true) return null
      const r = quota.remaining
      if (r === null || r === undefined || !Number.isFinite(r)) return null
      if (Number.isFinite(quota.total) && quota.total > 0 && Number.isFinite(quota.percentUsed)) {
        const pct = Math.max(0, Math.min(100, Math.round((100 - quota.percentUsed) * 10) / 10))
        return { label: 'ZCode', value: pct + '%' }
      }
      return { label: 'ZCode', value: fmtTokens(r) }
    }

    // ---- 侧栏入口按钮：形态由宿主侧栏的 wide 标志驱动（与原生「新会话」按钮同一套
    // 折叠编排：收起时宽栏内容随侧栏淡出，settle 后 rail 图标淡入），宿主未传 wide 时
    // 回退到容器查询；有预警时图标右上角琥珀点 ----
    // 侧栏条目行：名称「基元费用」，右侧紧跟常驻余额胶囊。
    const ENTRY_LABEL = '基元费用'
    // 面板标题保留完整名称，与侧栏条目的短标签区分。
    const PANEL_TITLE = '基元律动-费用中心'
    // 切到 ZCode 时，条目名与胶囊换成 ZCode 身份（显示套餐剩余%）
    const ZC_ENTRY_LABEL = 'ZCode 费用'
    // 限时余额悬浮卡：只显示逐笔限时额度（金额 + N 天后失效），无限时数据不渲染、
    // 限时为 0 不显示弹窗（用户定稿）。fixed 定位按入口 rect 计算，进卡片保持显示。
    const HOV_SHOW_DELAY_MS = 400
    const HOV_HIDE_DELAY_MS = 150
    const HOV_WIDTH = 260
    const expDaysLeft = (expireAt) => {
      const days = expiryDaysOf(expireAt)
      // 已过期逐笔（平台可能仍列出）夹到 0：显示「今天失效」，不出现负数天数。
      return days === null ? null : Math.max(0, days)
    }
    function ExpiringHoverCard({ rect, items, onEnter, onLeave, onOpen }) {
      const total = items.reduce((acc, it) => acc + (Number.isFinite(it.amountCny) ? it.amountCny : 0), 0)
      const left = Math.max(8, Math.min(rect.right - HOV_WIDTH, window.innerWidth - HOV_WIDTH - 8))
      const bottom = Math.max(8, window.innerHeight - rect.top + 8)
      return React.createElement('div', {
        className: 'dsh-mb-hov',
        style: { left: left + 'px', bottom: bottom + 'px', width: HOV_WIDTH + 'px' },
        onMouseEnter: onEnter,
        onMouseLeave: onLeave,
        onClick: onOpen,
        role: 'status',
      },
        React.createElement('div', { className: 'dsh-mb-hov-head' },
          '⏳ 限时余额' + (items.length > 1 ? ' · 共 ¥' + fmtCny(total) : '')),
        items.map((it, i) => {
          const days = expDaysLeft(it.expireAt)
          const soon = days !== null && days <= 3
          return React.createElement('div', { key: i, className: 'dsh-mb-hov-item' + (soon ? ' soon' : '') },
            React.createElement('span', { className: 'dsh-mb-hov-amt' }, '¥' + fmtCny(it.amountCny)),
            React.createElement('span', { className: 'dsh-mb-hov-days' },
              days === null ? '到期时间未知' : days === 0 ? '今天失效' : days + ' 天后失效'),
          )
        }),
      )
    }
    // ---- 侧栏条目行：注入到「记忆系统 / 技能中心」同族行的下方 ----
    // 结构对齐官方侧栏行（图标 + 名称 + 右侧余额胶囊）；悬停仍浮出限时余额时间线。
    function EntryRow() {
      const s = useStore()
      // ZCode 胶囊接管标记（面板切到 ZCode → 胶囊跟随显示套餐剩余%）
      const zcOn = s.provider === 'zcode' && s.zcEntry && typeof s.zcEntry.value === 'string' && s.zcEntry.value !== ''
      // ZCode 身份：只要面板切到 ZCode 就换图标/文字；数值缺席时胶囊回落基元余额
      const zcProv = s.provider === 'zcode'
      const label = zcProv ? ZC_ENTRY_LABEL : ENTRY_LABEL
      const title = zcOn
        ? ZC_ENTRY_LABEL + '（' + s.zcEntry.value + '）'
        : s.alert && !zcProv
          ? ENTRY_LABEL + '（' + (s.alert.expiring ? '限时额度 ' + expiryLabel(s.alert.expiringDays) : '余额不足') + '）'
          : zcProv ? ZC_ENTRY_LABEL : ENTRY_LABEL
      // 悬浮卡：按钮 hover 400ms 显示，移开 150ms 收起；移入卡片不中断。
      const [hovOpen, setHovOpen] = useState(false)
      const [hovRect, setHovRect] = useState(null)
      const btnRef = useRef(null)
      const hovTimers = useRef({ open: null, close: null })
      useEffect(() => () => {
        clearTimeout(hovTimers.current.open)
        clearTimeout(hovTimers.current.close)
      }, [])
      const hovItems = Array.isArray(s.expiringItems) ? s.expiringItems : []
      const hovCapable = hovItems.length > 0 && !s.open && !zcProv
      const hovEnter = (immediate) => {
        clearTimeout(hovTimers.current.close)
        clearTimeout(hovTimers.current.open)
        if (!hovCapable) return
        const btn = btnRef.current
        if (btn) setHovRect(btn.getBoundingClientRect())
        hovTimers.current.open = setTimeout(() => setHovOpen(true), immediate ? 0 : HOV_SHOW_DELAY_MS)
      }
      const hovLeave = () => {
        clearTimeout(hovTimers.current.open)
        clearTimeout(hovTimers.current.close)
        hovTimers.current.close = setTimeout(() => setHovOpen(false), HOV_HIDE_DELAY_MS)
      }
      // 胶囊金额按设置模式取值：total = 账户总余额；expiring = 逐笔限时合计（无
      // 限时数据时不显示胶囊，与「限时为 0 不显示弹窗」同口径）。
      const entryMode = s.entryBalMode === 'expiring' ? 'expiring' : 'total'
      let pillVal = null
      if (entryMode === 'total') pillVal = s.balanceCny
      else if (hovItems.length > 0) pillVal = hovItems.reduce((a, it) => a + (Number.isFinite(it.amountCny) ? it.amountCny : 0), 0)
      let balText = pillVal !== null && pillVal !== undefined ? '¥' + fmtCny(pillVal) : null
      // 面板切到 ZCode → 胶囊改显套餐剩余%（store.zcEntry 由 Panel 仲裁）
      if (zcOn) balText = s.zcEntry.value
      const alert = !!(s.alert && !zcProv)
      const btnProps = {
        className: 'dsh-mb-nav-row' + (s.open ? ' active' : ''),
        type: 'button',
        ref: btnRef,
        'aria-label': label,
        onClick: () => setStore({ open: !s.open }),
        onMouseEnter: () => hovEnter(false),
        onMouseLeave: hovLeave,
      }
      if (!hovCapable) btnProps.title = title // 有悬浮卡时去掉原生 title，避免双气泡
      return React.createElement(React.Fragment, null,
        React.createElement('button', btnProps,
          React.createElement('span', { className: 'dsh-mb-nav-icon' },
            zcProv ? ZcMark({ size: 18 }) : EntryMark({ size: 18 }),
            alert ? React.createElement('span', { className: 'dsh-mb-dot' }) : null,
          ),
          React.createElement('span', { className: 'dsh-mb-nav-label' }, label),
          balText ? React.createElement('span', { className: 'dsh-mb-nav-bal' + (alert ? ' alert' : '') }, balText) : null,
        ),
        hovOpen && hovCapable && hovRect
          ? React.createElement(ExpiringHoverCard, {
            rect: hovRect,
            items: hovItems,
            onEnter: () => hovEnter(true),
            onLeave: hovLeave,
            onOpen: () => { setHovOpen(false); setStore({ open: true }) },
          })
          : null,
      )
    }

    // 密码可见性图标（feather eye / eye-off 线稿，替代「明文/隐藏」汉字按钮文案）。
    const EyeIcon = ({ off }) => React.createElement('svg', {
      viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor',
      strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
    },
      off
        ? [
          React.createElement('path', { key: 'p', d: 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24' }),
          React.createElement('line', { key: 'l', x1: 1, y1: 1, x2: 23, y2: 23 }),
        ]
        : [
          React.createElement('path', { key: 'p', d: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' }),
          React.createElement('circle', { key: 'c', cx: 12, cy: 12, r: 3 }),
        ],
    )

    // 侧栏入口图标：基元律动品牌标（tokenrhythm.studio 官方 brand-logo.svg 的图形部分，
    // 三个 fill path；viewBox 按墨迹紧裁 10.4213 15.2079 60.8522 37.2003；fill:currentColor
    // 跟随文字色，明暗主题自动适配）。SVG 几何盒与原生 16/18px 线稿图标一致，折叠态不跑偏。
    const MARK_VIEWBOX = '10.4213 15.2079 60.8522 37.2003'
    const MARK_ASPECT = 37.2003 / 60.8522
    const MARK_PATHS = ["M28.2869 15.3313L52.3032 15.3318C56.6495 15.332 61.1409 15.3885 65.4782 15.3038C62.4476 17.8251 58.7745 21.2659 55.8259 23.9557C54.451 24.0375 52.5027 23.9839 51.0859 23.9842C48.459 23.9946 45.832 23.9874 43.2052 23.9626C44.8543 25.4287 47.4485 28.1941 49.1119 29.8604L61.0355 41.7999L68.4647 49.2348C68.9123 49.6831 71.0764 51.7891 71.2735 52.1321L71.1537 52.1688C67.1352 52.0344 62.9706 52.1522 58.9688 51.9728L45.811 38.8082C42.8897 35.885 39.8219 32.8966 36.9616 29.9257L36.9693 44.1437C34.1378 46.911 31.1624 49.6754 28.2845 52.4082L28.2869 15.3313Z","M66.8075 16.3432C66.9854 16.5409 66.8988 26.5212 66.8939 27.8531C64.2096 30.6301 61.1162 33.5951 58.3448 36.3093L55.4318 33.3274C54.3728 32.2341 53.3067 31.1479 52.2334 30.0688L66.8075 16.3432Z","M20.3634 15.2565C22.2816 15.2079 24.3745 15.2491 26.3065 15.2484C26.241 18.0694 26.2922 21.1045 26.2817 23.9411L16.4729 23.9386C14.5285 23.9342 12.3458 23.8846 10.4213 23.964C13.7597 21.1535 17.0176 18.0347 20.3634 15.2565Z"]
    const EntryMark = ({ size }) => React.createElement('svg', {
      width: size, height: size * MARK_ASPECT, viewBox: MARK_VIEWBOX, fill: 'none',
      'aria-hidden': 'true',
    }, MARK_PATHS.map((d, i) => React.createElement('path', { key: i, d, fill: 'currentColor' })))

    // 侧栏入口图标（ZCode 模式）：feather zap 线稿（额度/能量意象），与其他
    // 24 viewBox 线稿同语言，currentColor 跟随文字色，明暗主题自动适配。
    const ZcMark = (props) => React.createElement('svg', {
      width: (props && props.size) || 16, height: (props && props.size) || 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true',
      stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    },
      React.createElement('polygon', { points: '13 2 3 14 12 14 11 22 21 10 12 10 13 2' }),
    )

    // ---- 面板 ----
    function Panel() {
      const s = useStore()
      const [view, setView] = useState('balance') // 'balance'|'models'|'keys'；'zc-usage'|'zc-claim'。设置走弹窗不占视图
      const lastTabRef = useRef('balance')
      const [pos, setPos] = useState(null) // {x,y,w,h?}；prefs 加载前 null → 面板不渲染避免闪跳
      const posRef = useRef(null)
      const panelRef = useRef(null)
      const [manifest, setManifest] = useState(null)
      const [providerId, setProviderId] = useState('')
      const [models, setModels] = useState(null)
      const [modelsReload, setModelsReload] = useState(0) // 凭据切换后强制重拉模型清单
      const [catFilter, setCatFilter] = useState('all')
      const [balance, setBalance] = useState(null)
      const [copiedId, setCopiedId] = useState(null)
      const [showCalls, setShowCalls] = useState(false)
      const [trendHoverIdx, setTrendHoverIdx] = useState(null)
      // 账号管理（设置页：账号密码池）
      const [accounts, setAccounts] = useState(null)
      const [addAcc, setAddAcc] = useState('')
      const [addPw, setAddPw] = useState('')
      const [showAddPw, setShowAddPw] = useState(false)
      const [accBusy, setAccBusy] = useState(false)
      const [accMsg, setAccMsg] = useState(null)
      const [showAccPw, setShowAccPw] = useState(null) // 明文显示密码的账号
      // 密钥页：本机凭据池（API Key + Cookie）
      const [creds, setCreds] = useState(null) // { loading, list, active, error }
      const [credKey, setCredKey] = useState('')
      const [credCookie, setCredCookie] = useState('')
      const [credTip, setCredTip] = useState(null) // 录入/切换结果的即时反馈
      const [credBusy, setCredBusy] = useState(false)
      const [copiedCred, setCopiedCred] = useState(null) // 'id:all' | 'id:key' | 'id:cookie'
      // ---- 提供商切换（基元 / ZCode）：'tr' | 'zcode' ----
      const [provider, setProvider] = useState('tr')
      const providerInitRef = useRef(false)
      const lastZcTabRef = useRef('zc-usage')
      const providerRef = useRef('tr') // 胶囊仲裁读取的实时提供商（避开 useCallback 闭包）
      const zcQuotaRef = useRef(null) // 最近一次 ZCode 额度数据（切提供商即时换胶囊用）
      // ---- ZCode 页签（额度展示 + 活动领取；读 ~/.zcode/v2 凭证，接口经 host 代理）----
      const [zcQuota, setZcQuota] = useState(null)
      const [zcPlans, setZcPlans] = useState(null)
      const [zcMsg, setZcMsg] = useState(null)
      const [settingsTab, setSettingsTab] = useState('tr') // 设置弹窗分组：基元/ZCode/关于

      const setPosSafe = (p) => { posRef.current = p; setPos(p) }

      // 设置改为右上角齿轮打开的弹窗（不再占视图）；进出不改变当前页签。
      const switchTab = useCallback((id) => {
        if (String(id).indexOf('zc-') === 0) lastZcTabRef.current = id
        else lastTabRef.current = id
        setView(id)
        setStore({ view: id })
      }, [])
      const toggleSettings = useCallback(() => {
        setStore({ settingsOpen: !(store.settingsOpen === true) })
      }, [])

      // ---- 面板提供商切换（标题分段器：基元 / ZCode）：切到 ZCode → 胶囊跟随显示套餐剩余
      // （store.provider/zcEntry 由 EntryRow 消费）；切回基元则整体还原身份。----
      const switchProvider = useCallback((p) => {
        const want = p === 'zcode' ? 'zcode' : 'tr'
        if (want === provider) return
        setProvider(want)
        providerRef.current = want
        // 切提供商即仲裁胶囊：ZCode 用最近一次额度缓存（无数据则回落基元身份）
        setStore({ provider: want, zcEntry: want === 'zcode' ? computeZcEntry({ provider: 'zcode', quota: zcQuotaRef.current }) : null })
        setView((v) => {
          if (want === 'zcode') return String(v).indexOf('zc-') === 0 ? v : lastZcTabRef.current
          return String(v).indexOf('zc-') === 0 ? lastTabRef.current : v
        })
      }, [provider])
      // ZCode 集成被关闭后自动落回基元（胶囊/页签一并还原）
      useEffect(() => {
        if (provider === 'zcode' && s.zcodeEnabled !== true) {
          setProvider('tr')
          providerRef.current = 'tr'
          setStore({ provider: 'tr', zcEntry: null })
        }
      }, [provider, s.zcodeEnabled])

      useEffect(() => { providerRef.current = provider }, [provider])

      // provider 与 view 必须同族（TR 页签配基元、zc 页签配 ZCode）——否则首个提供商
      // 切换时面板会以「A 页签 + B 内容」的错位状态初始化（view 初始硬编码 'balance'，
      // switchProvider 对已就位的 provider 会早退不搬 view）。
      useEffect(() => {
        const isZc = String(view).indexOf('zc-') === 0
        if (provider === 'zcode' && !isZc) { setView(lastZcTabRef.current); setStore({ view: lastZcTabRef.current }) }
        else if (provider !== 'zcode' && isZc) { setView(lastTabRef.current); setStore({ view: lastTabRef.current }) }
      }, [provider, view])

      // ---- ZCode 页签：用量 60s 轮询、活动进页签拉一次；领取结果由弹窗页
      // postMessage 回传（同源路由与 CSP 回退服务器两个来源都收）。----
      const loadZcQuota = useCallback((force) => {
        setZcQuota((cur) => ({ loading: true, data: cur && cur.data }))
        jsonGet(API + '/zcode/quota' + (force === true ? '?force=1' : '')).then((r) => {
          if (r && r.ok) {
            zcQuotaRef.current = r
            setZcQuota({ loading: false, data: r })
            setStore({ zcEntry: computeZcEntry({ provider: providerRef.current, quota: r }) })
          } else {
            zcQuotaRef.current = null
            setZcQuota({ loading: false, error: (r && r.error) || '加载失败', code: r && r.code })
            setStore({ zcEntry: null }) // 无数据 → 胶囊回落基元身份
          }
        })
      }, [])
      const loadZcPlans = useCallback(() => {
        setZcPlans((cur) => ({ loading: true, list: (cur && cur.list) || null }))
        jsonGet(API + '/zcode/claim/preview').then((r) => {
          if (r && r.ok) setZcPlans({ loading: false, list: r.plans || [], activated: r.activated, activationError: r.activationError || null })
          else setZcPlans({ loading: false, error: (r && r.error) || '加载失败', biz: r && r.code === 'CLAIM_BIZ' ? r : null })
        })
      }, [])
      useEffect(() => {
        if (!s.open || provider !== 'zcode') return
        if (view === 'zc-claim') { loadZcPlans(); return }
        loadZcQuota()
        const t = setInterval(loadZcQuota, 60 * 1000)
        return () => clearInterval(t)
      }, [s.open, provider, view, loadZcQuota, loadZcPlans])
      const claimZcodePlan = useCallback((plan) => {
        const w = window.open(API + '/captcha?planId=' + encodeURIComponent(plan.planId), 'dsh-zcode-captcha', 'width=440,height=620')
        if (!w) setZcMsg({ ok: false, text: '弹窗被拦截，请允许本站弹出窗口后重试' })
      }, [])
      useEffect(() => {
        const onMsg = (e) => {
          const d = e && e.data
          if (!d || d.source !== 'dsh-tokenrhythm-bill' || d.kind !== 'zcode-claim') return
          setZcMsg(d.ok
            ? { ok: true, text: '领取成功' + (d.planName ? '：' + d.planName : '') }
            : { ok: false, text: d.message || '领取失败' })
          if (d.ok) { loadZcQuota(true); loadZcPlans() }
        }
        window.addEventListener('message', onMsg)
        return () => window.removeEventListener('message', onMsg)
      }, [loadZcQuota, loadZcPlans])

      // 首开：加载面板几何 + manifest。
      useEffect(() => {
        let alive = true
        jsonGet(API + '/prefs').then((r) => {
          if (!alive || !r || !r.ok || !r.prefs) return
          if (r.prefs.panel) setPosSafe(sanitizePos(r.prefs.panel))
          setStore({ zcodeEnabled: r.prefs.zcode === true }) // ZCode 集成默认关闭
        })
        jsonGet(API + '/manifest').then((r) => {
          if (!alive) return
          setManifest(r && r.ok ? r : { ok: false, providers: [], error: r && r.error ? r.error : '加载失败' })
          if (r && r.ok && Array.isArray(r.providers) && r.providers.length > 0) {
            setProviderId((cur) => (cur !== '' && r.providers.some((p) => p.id === cur) ? cur : r.providers[0].id))
          }
          // 基元是唯一常驻提供商：首包不必播种（ZCode 由设置开关显式切换）。
          providerInitRef.current = true
        })
        return () => { alive = false }
      }, [])

      // 默认几何：视口水平居中、距顶 72px。prefs 到达后覆盖。
      useEffect(() => {
        if (pos !== null) return
        const w = Math.min(560, window.innerWidth - 16)
        setPosSafe({ x: Math.round((window.innerWidth - w) / 2), y: 72, w })
      }, [pos === null])

      // Esc / 点击面板外部关闭。Esc 优先关设置弹窗，再关面板。
      useEffect(() => {
        if (!s.open) return
        const onKey = (e) => {
          if (e.key !== 'Escape') return
          if (store.settingsOpen) setStore({ settingsOpen: false })
          else setStore({ open: false })
        }
        const onDown = (e) => {
          const el = panelRef.current
          if (el && !el.contains(e.target) && !(e.target.closest && e.target.closest('.dsh-mb-nav-row, .dsh-mb-hov'))) {
            setStore({ open: false })
          }
        }
        window.addEventListener('keydown', onKey)
        document.addEventListener('pointerdown', onDown, true)
        return () => {
          window.removeEventListener('keydown', onKey)
          document.removeEventListener('pointerdown', onDown, true)
        }
      }, [s.open])

      // 模型列表：随 providerId 变化拉取（host 端 60s 缓存）。
      useEffect(() => {
        if (!s.open || providerId === '' || view !== 'models') return
        let alive = true
        setModels({ loading: true })
        jsonGet(API + '/models?provider=' + encodeURIComponent(providerId)).then((r) => {
          if (!alive) return
          if (r && r.ok) setModels({ loading: false, list: r.models || [], cached: !!r.cached, stale: !!r.stale, categories: r.categories || null, source: r.source })
          else setModels({ loading: false, error: (r && r.error) || '加载失败', code: r && r.code })
          if (!r || !r.ok || !r.categories) setCatFilter('all')
        })
        return () => { alive = false }
      }, [providerId, view, s.open, modelsReload])

      const loadBalance = useCallback(() => {
        setBalance((cur) => ({ loading: true, data: cur && cur.data }))
        jsonGet(API + '/balance').then((r) => {
          if (r && r.ok) {
            setBalance({ loading: false, data: r })
            setStore({
              alert: alertOf(r),
              balanceCny: r.balanceCny !== null && r.balanceCny !== undefined ? r.balanceCny : null,
              expiringItems: Array.isArray(r.expiringItems) ? r.expiringItems : [],
            })
          } else {
            setBalance({ loading: false, error: (r && r.error) || '加载失败', code: r && r.code })
          }
        })
      }, [])

      // 凭据变化后统一刷新：manifest（会话/密钥掩码）+ 余额 + 模型清单。旧身份的
      // 余额与预警立即失效，避免把上一个身份的 ¥ 当成当前身份的看。
      const refreshSession = useCallback(async () => {
        const m = await jsonGet(API + '/manifest')
        if (m && m.ok) setManifest(m)
        setStore({ alert: null, balanceCny: null, expiringItems: [] })
        loadBalance()
        setModelsReload((n) => n + 1)
      }, [])

      // 当前登录账号（manifest 会话里带的）：作为余额刷新依赖，切换账号立即重拉。
      const sessionAccount = (manifest && manifest.session && manifest.session.account) || null
      // 平台用户名（/api/me 提取，manifest.accountName）：数据账号标注用它，
      // 账号密码模式下 account 只是登录手机号，不适合当展示名。
      const sessionAccountName = (manifest && manifest.session && manifest.session.accountName) || null
      // 余额：页签打开时拉取，之后每 60s 自动刷新（面板开着才刷）；切换账号立即刷新，
      // 避免把上一个账号的数据当成当前账号的看。
      useEffect(() => {
        if (!s.open || view !== 'balance') return
        loadBalance()
        const timer = setInterval(loadBalance, 60 * 1000)
        return () => clearInterval(timer)
      }, [view, s.open, loadBalance, sessionAccount])

      // 密钥页：本机凭据池（API Key + Cookie）——列表 / 录入 / 选用 / 删除。
      const loadCreds = useCallback(async () => {
        setCreds((cur) => ({ ...(cur || {}), loading: true }))
        const r = await jsonGet(API + '/creds')
        if (r && r.ok) setCreds({ loading: false, list: r.creds || [], active: r.active || null, dshKey: r.dshKey || null })
        else setCreds({ loading: false, list: [], active: null, error: (r && r.error) || '加载失败' })
      }, [])
      useEffect(() => {
        if (!s.open || view !== 'keys') return
        loadCreds()
      }, [view, s.open, loadCreds])
      // 保存一条凭据（API Key / Cookie，至少一项）：只入库，不改当前身份——选用由列表里的「使用」触发。
      const addCred = async () => {
        setCredBusy(true)
        setCredTip(null)
        const payload = { apiKey: credKey.trim(), cookie: credCookie }
        let r = await jsonPost(API + '/creds/add', payload)
        // 兼容尚未重启的旧版后台：它仍要求 name，补一个占位名重试一次，避免保存被挡。
        if (r && !r.ok && typeof r.error === 'string' && r.error.indexOf('名称') >= 0) {
          r = await jsonPost(API + '/creds/add', { ...payload, name: 'cred-' + Date.now() })
        }
        setCredBusy(false)
        if (!r || !r.ok) { setCredTip({ ok: false, text: (r && r.error) || '保存失败' }); return }
        setCredKey('')
        setCredCookie('')
        setCredTip({ ok: true, text: '已保存；点这条记录右侧的「使用」后才会生效' })
        await loadCreds()
      }
      // 选用（id 为空 = 停用当前凭据）/ 删除：host 换上或移除该条的 Key 与 Cookie，本埠只刷新界面。
      const useCred = async (id) => {
        setCredBusy(true)
        const r = await jsonPost(API + '/creds/use', { id })
        setCredBusy(false)
        if (!r || !r.ok) { setCredTip({ ok: false, text: (r && r.error) || '切换失败' }); return }
        setCredTip({ ok: true, text: id === '' ? '已停止使用所选凭据' : '已切换到所选凭据' })
        await loadCreds()
        await refreshSession()
      }
      const removeCred = async (id) => {
        setCredBusy(true)
        const r = await jsonPost(API + '/creds/remove', { id })
        setCredBusy(false)
        if (!r || !r.ok) { setCredTip({ ok: false, text: (r && r.error) || '删除失败' }); return }
        setCredTip({ ok: true, text: '已删除该凭据' })
        await loadCreds()
        await refreshSession()
      }
      // 复制凭据内容：kind = 'all'（API Key 与 Cookie 合并成一段）/ 'key' / 'cookie'。
      // 未填写的部分不参与拼接，避免复制出空行。
      const copyCred = useCallback(async (cred, kind) => {
        const keyText = cred.apiKey || ''
        const cookieText = cred.cookieRaw || cred.cookie || ''
        const text = kind === 'all'
          ? [keyText, cookieText].filter((s) => s !== '').join('\n')
          : kind === 'key' ? keyText : cookieText
        if (text === '') return
        if (!(await copyText(text))) return
        const tag = cred.id + ':' + kind
        setCopiedCred(tag)
        setTimeout(() => setCopiedCred((cur) => (cur === tag ? null : cur)), 1500)
      }, [])

      // 入口胶囊显示模式（total=总余额 / expiring=限时总余额）：本地立即生效 + 持久化。
      const setEntryBalance = useCallback((mode) => {
        if (mode !== 'total' && mode !== 'expiring') return
        setStore({ entryBalMode: mode })
        void jsonPost(API + '/prefs', { prefs: { entryBalance: mode } })
      }, [])
      // ZCode 集成开关：本地立即生效 + 持久化到 host prefs；关闭时若正停在
      // ZCode 页签，由「关闭回落」effect 自动切回基元。
      const setZcodeEnabled = useCallback((on) => {
        setStore({ zcodeEnabled: on === true })
        void jsonPost(API + '/prefs', { prefs: { zcode: on === true } })
      }, [])

      // 点击模型卡片 → 复制模型 id（配置 agent 时直接粘贴）。
      const copyId = useCallback((id) => {
        void copyText(id)
        setCopiedId(id)
        setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1200)
      }, [])

      // 账号管理：添加（保存并可明文查看）/ 删除 / 一键登录。
      const loadAccounts = useCallback(async () => {
        const r = await jsonGet(API + '/accounts')
        if (r && r.ok) setAccounts(r.accounts || [])
      }, [])
      const addAccount = async () => {
        setAccBusy(true)
        setAccMsg(null)
        const r = await jsonPost(API + '/accounts/add', { account: addAcc.trim(), password: addPw })
        setAccBusy(false)
        if (!r || !r.ok) { setAccMsg({ ok: false, text: (r && r.error) || '操作失败' }); return }
        if (r.loggedIn) {
          setAccMsg({ ok: true, text: '已添加并登录：' + r.hint })
          setAddPw('')
          const m = await jsonGet(API + '/manifest')
          if (m && m.ok) setManifest(m)
          setStore({ alert: null, balanceCny: null, expiringItems: [] })
          loadBalance()
        } else {
          setAccMsg({ ok: true, text: '账号已保存，但登录失败：' + (r.error || '未知原因') })
        }
        loadAccounts()
      }
      const removeAccount = async (account) => {
        await jsonPost(API + '/accounts/remove', { account })
        if (showAccPw === account) setShowAccPw(null)
        loadAccounts()
      }
      const loginStored = async (account) => {
        setAccBusy(true)
        setAccMsg(null)
        const r = await jsonPost(API + '/accounts/login', { account })
        setAccBusy(false)
        if (r && r.ok) {
          setAccMsg({ ok: true, text: '已切换登录：' + account })
          const m = await jsonGet(API + '/manifest')
          if (m && m.ok) setManifest(m)
          setStore({ alert: null, balanceCny: null, expiringItems: [] })
          loadBalance()
        } else {
          setAccMsg({ ok: false, text: (r && r.error) || '登录失败' })
        }
      }

      // 账号列表：打开设置弹窗时拉取（添加/删除后会再刷新），否则列表永远不出现。
      useEffect(() => {
        if (!s.open || !s.settingsOpen) return
        loadAccounts()
      }, [s.open, s.settingsOpen, loadAccounts])

      // ---- 更新检测：打开设置弹窗时拉取（host 端 24h TTL，force=1 绕过）----
      const [updInfo, setUpdInfo] = useState(null)
      const [updBusy, setUpdBusy] = useState(false)
      const [updCopied, setUpdCopied] = useState(false)
      const loadUpdate = useCallback(async (force) => {
        setUpdBusy(true)
        const r = await jsonGet(API + '/update' + (force ? '?force=1' : '')).catch(() => null)
        setUpdBusy(false)
        if (r && r.ok) setUpdInfo(r)
      }, [])
      useEffect(() => {
        if (!s.open || !s.settingsOpen) return
        loadUpdate(false)
      }, [s.open, s.settingsOpen, loadUpdate])
      const copyUpdateCmd = () => {
        void copyText('dsh plugin add dsh-tokenrhythm-bill')
        setUpdCopied(true)
        setTimeout(() => setUpdCopied(false), 1500)
      }
      const ignoreUpdate = async () => {
        const r = await jsonPost(API + '/update/ignore', { version: updInfo && updInfo.latest ? updInfo.latest : '' })
        if (r && r.ok) setUpdInfo((cur) => (cur ? { ...cur, ...r } : r))
      }

      // ---- 拖拽（头部按下拖动，松开持久化）----
      const persistPos = () => {
        const cur = posRef.current
        if (cur) {
          const panel = { x: Math.round(cur.x), y: Math.round(cur.y), w: Math.round(cur.w) }
          if (cur.h) panel.h = Math.round(cur.h)
          void jsonPost(API + '/prefs', { prefs: { panel } })
        }
      }
      const onHeaderDown = (e) => {
        if (e.button !== 0) return
        const target = e.target
        if (target && target.closest && target.closest('button')) return // 头部按钮不触发拖拽
        e.preventDefault()
        const p = posRef.current || { x: 0, y: 0, w: 560 }
        const startX = e.clientX, startY = e.clientY, origX = p.x, origY = p.y
        const move = (ev) => {
          setPosSafe(clampPos({ x: origX + ev.clientX - startX, y: origY + ev.clientY - startY, w: p.w, h: p.h }))
        }
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          persistPos()
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }

      // ---- 右下角把手：调整宽高并持久化 ----
      const onResizeDown = (e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        const p = posRef.current || { x: 0, y: 0, w: 560 }
        const startX = e.clientX, startY = e.clientY, w0 = p.w
        const h0 = p.h || (panelRef.current ? panelRef.current.offsetHeight : 480)
        const move = (ev) => {
          const w = Math.max(360, Math.min(w0 + ev.clientX - startX, window.innerWidth - 16))
          const h = Math.max(280, Math.min(h0 + ev.clientY - startY, window.innerHeight - 40))
          setPosSafe(clampPos({ x: p.x, y: p.y, w, h }))
        }
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          persistPos()
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }

      if (!s.open || pos === null) return null
      const providers = (manifest && Array.isArray(manifest.providers)) ? manifest.providers : []
      const sessionConfigured = !!(manifest && manifest.session && manifest.session.configured)
      const effProv = provider === 'zcode' && s.zcodeEnabled ? 'zcode' : 'tr'
      return React.createElement('div', {
        className: 'dsh-mb-panel' + (s.settingsOpen ? ' settings-open' : ''),
        ref: panelRef,
        style: { left: pos.x, top: pos.y, width: pos.w, height: pos.h || undefined },
        role: 'dialog',
      },
        // 头部：原标题（任何模式保留）+ 提供商切换器（配好 ZCode 才出现，紧贴标题）
        // + 右上角动作区（设置齿轮 / 关闭）。
        React.createElement('div', { className: 'dsh-mb-head', onPointerDown: onHeaderDown },
          React.createElement('div', { className: 'dsh-mb-head-left' },
            React.createElement('span', { className: 'dsh-mb-head-title' },
              effProv === 'zcode' ? ZC_ENTRY_LABEL : PANEL_TITLE),
            // 标题位提供商切换器：基元常驻，ZCode 需设置里启用；
            // 只剩基元一个段时整体不渲染（未开启 ZCode 时零打扰）。
            (function () {
              const segs = [['tr', '基元', '基元律动面板']]
              if (s.zcodeEnabled) segs.push(['zcode', 'ZCode', 'ZCode 套餐与活动'])
              if (segs.length < 2) return null
              return React.createElement('div', { className: 'dsh-mb-prov' },
                segs.map(([id, label, tip]) => React.createElement('button', {
                  key: id,
                  className: 'dsh-mb-prov-btn' + (effProv === id ? ' active' : ''),
                  title: tip, onClick: () => switchProvider(id),
                }, label)),
              )
            })(),
          ),
          React.createElement('div', { className: 'dsh-mb-head-actions' },
            React.createElement('button', {
              className: 'dsh-mb-iconbtn' + (s.settingsOpen ? ' active' : ''),
              title: '设置',
              onClick: toggleSettings,
            }, '⚙'),
            React.createElement('button', { className: 'dsh-mb-iconbtn', title: '关闭 (Esc)', onClick: () => setStore({ open: false }) }, '✕'),
          ),
        ),
        // 页签：基元 / ZCode 各一套（设置以弹窗打开，不占页签）。
        React.createElement('div', { className: 'dsh-mb-tabs' },
          (effProv === 'zcode'
            ? [['zc-usage', '用量'], ['zc-claim', '活动']]
            : [['balance', '余额'], ['models', '模型'], ['keys', '密钥']]).map(([id, label]) =>
            React.createElement('button', {
              key: id,
              className: 'dsh-mb-tab' + (view === id ? ' active' : ''),
              onClick: () => switchTab(id),
            }, label)),
        ),
        React.createElement('div', { className: 'dsh-mb-body' },
          view === 'models' ? renderModelsTab({ manifest, providers, models, catFilter, setCatFilter, copiedId, copyId }) : null,
          view === 'balance' ? renderBalanceTab({ manifest, balance, loadBalance, goSettings: toggleSettings, goKeys: () => switchTab('keys'), showCalls, setShowCalls, trendHoverIdx, setTrendHoverIdx, sessionAccount, sessionAccountName }) : null,
          view === 'keys' ? renderCredsTab({
            manifest, creds, loadCreds, credKey, setCredKey,
            credCookie, setCredCookie,
            credBusy, credTip, addCred, useCred, removeCred, copiedCred, copyCred,
          }) : null,
          view === 'zc-usage' ? renderZcUsageTab({
            zcQuota, loadZcQuota,
          }) : null,
          view === 'zc-claim' ? renderZcClaimTab({
            zcPlans, loadZcPlans, zcMsg, claimZcodePlan,
          }) : null,
        ),
        // 设置弹窗：覆盖整个面板的模态层（点遮罩 / ✕ / Esc 关闭）。
        s.settingsOpen ? React.createElement('div', {
          className: 'dsh-mb-modal',
          onClick: (e) => { if (e.target === e.currentTarget) setStore({ settingsOpen: false }) },
        },
          React.createElement('div', { className: 'dsh-mb-modal-card', role: 'dialog', 'aria-label': '设置' },
            React.createElement('div', { className: 'dsh-mb-modal-head' },
              React.createElement('span', { className: 'dsh-mb-modal-title' }, '设置'),
              React.createElement('button', {
                className: 'dsh-mb-iconbtn', title: '关闭 (Esc)',
                onClick: () => setStore({ settingsOpen: false }),
              }, '✕'),
            ),
            React.createElement('div', { className: 'dsh-mb-modal-body' },
              renderSettingsTab({
                manifest, sessionConfigured, sessionAccount: (manifest && manifest.session && manifest.session.account) || null,
                accounts, addAcc, setAddAcc, addPw, setAddPw, showAddPw, setShowAddPw,
                accBusy, accMsg, addAccount, removeAccount, loginStored, showAccPw, setShowAccPw,
                updInfo, updBusy, loadUpdate, copyUpdateCmd, updCopied, ignoreUpdate,
                entryMode: s.entryBalMode === 'expiring' ? 'expiring' : 'total', setEntryBalance,
                zcEnabled: s.zcodeEnabled === true, setZcodeEnabled,
                settingsTab, setSettingsTab,
              })),
          ),
        ) : null,
        React.createElement('div', { className: 'dsh-mb-resize', title: '调整大小', onPointerDown: onResizeDown }),
      )
    }

    const sanitizePos = (p) => {
      const w = Math.min(860, Math.max(360, Number(p.w) || 560), window.innerWidth - 16)
      const h = p.h ? Math.max(280, Math.min(Number(p.h) || 480, window.innerHeight - 40)) : null
      return clampPos({ x: Number(p.x) || 0, y: Number(p.y) || 0, w, h })
    }
    const clampPos = ({ x, y, w, h }) => ({
      x: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - 80)),
      w,
      h: h || null,
    })

    // ---- 模型页签（卡片网格 + 分类筛选；点卡片复制模型 id）----
    const CAT_LABELS = { all: '全部', text: '文本', image: '图像', audio: '音频', video: '视频', vector: '向量' }
    function renderModelsTab({ manifest, providers, models, catFilter, setCatFilter, copiedId, copyId }) {
      if (manifest && manifest.error) {
        return React.createElement('div', { className: 'dsh-mb-notice err' }, manifest.error)
      }
      if (providers.length === 0) {
        return React.createElement('div', { className: 'dsh-mb-notice' }, 'settings.yaml 里没有配置基元律动（tokenrhythm）提供商')
      }
      const rows = []
      if (models === null || models.loading) {
        // 骨架屏：与模型卡片网格同构的 shimmer 占位（6 卡 × 三行），替代纯文字「加载中…」。
        rows.push(React.createElement('div', { className: 'dsh-mb-skel-cards', key: 'ld', role: 'status', 'aria-label': '加载中' },
          Array.from({ length: 6 }, (_, i) => React.createElement('div', { className: 'dsh-mb-skel-card', key: i },
            React.createElement('div', { className: 'dsh-mb-skel', style: { width: '58%' } }),
            React.createElement('div', { className: 'dsh-mb-skel', style: { width: '88%' } }),
            React.createElement('div', { className: 'dsh-mb-skel', style: { width: '42%' } }),
          ))))
      } else if (models.error) {
        rows.push(React.createElement('div', { className: 'dsh-mb-notice err', key: 'er' },
          models.code === 'NO_KEY' ? models.error : '拉取模型列表失败：' + models.error))
      } else {
        // 缓存标签并入分类 tabs 行首（保持一行；stale 长文案改放悬浮提示）。
        const cacheTag = models.cached
          ? React.createElement('span', {
              className: 'dsh-mb-cache-tag' + (models.stale ? ' stale' : ''),
              key: 'ct',
              title: models.stale ? '上游失败，显示 60s 前的缓存' : undefined,
            }, models.stale ? '缓存（上游失败）' : '缓存（60s 内）')
          : null
        if (models.list.length === 0) {
          rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'empty' }, '网关返回的模型列表为空'))
        }
        if (models.categories) {
          rows.push(React.createElement('div', { className: 'dsh-mb-cats', key: 'cats' },
            Object.keys(CAT_LABELS).map((key) => {
              const n = models.categories[key]
              if (key !== 'all' && !n) return null
              return React.createElement('button', {
                key,
                className: 'dsh-mb-cat' + (catFilter === key ? ' active' : ''),
                onClick: () => setCatFilter(key),
              }, CAT_LABELS[key] + ' ', React.createElement('span', { className: 'dsh-mb-cat-count' }, n || 0))
            }),
            // 缓存标签放行尾：margin-left:auto 吸走剩余空间 → chips 靠左、标签靠最右。
            cacheTag,
          ))
        } else if (cacheTag) {
          rows.push(React.createElement('div', { className: 'dsh-mb-cats', key: 'cats' }, cacheTag))
        }
        // 文本组在前、图像组在后，组内价格升序：图像模型按图片单价、文本模型按
        // 输入单价（有折扣取折扣价）；无价格的（网关 /v1/models 回退、平台未定价的
        // 测试模型）排在组尾，同价/无价组内保持平台原序（sort 稳定）。网关回退的
        // 模型没有 categories，视作文本组。
        const priceOf = (m) => (m.perImagePrice ?? m.effInPrice ?? m.inPrice ?? null)
        const groupOf = (m) => ((m.categories || []).includes('image') ? 1 : 0)
        const list = models.list
          .filter((m) => catFilter === 'all' || !(m.categories) || m.categories.includes(catFilter))
          .sort((a, b) => {
            const ga = groupOf(a)
            const gb = groupOf(b)
            if (ga !== gb) return ga - gb
            const pa = priceOf(a)
            const pb = priceOf(b)
            if (pa === null && pb === null) return 0
            if (pa === null) return 1
            if (pb === null) return -1
            return pa - pb
          })
        if (list.length === 0 && models.list.length > 0) {
          rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'nofilter' }, '该分类下暂无模型'))
        }
        rows.push(React.createElement('div', { className: 'dsh-mb-cards', key: 'cards' },
          list.map((m) => React.createElement('div', {
            className: 'dsh-mb-card' + (copiedId === m.id ? ' copied' : ''),
            key: m.id,
            title: '点击复制模型 ID：' + m.id,
            onClick: () => copyId(m.id),
          },
            // 卡片结构对齐平台模型页（model-card）：headline（折扣徽章 + 名称 + 状态胶囊）/
            // subline（模型 ID + 来源）/ details（规格 + 价格两栏 dl）。
            React.createElement('div', { className: 'dsh-mb-card-meta' },
              React.createElement('div', { className: 'dsh-mb-card-head' },
                // 折扣徽章：实底绿 + 白字放标题行最左（内容区左上角），行内排布不占额外高度。
                m.hasDiscount ? React.createElement('span', { className: 'dsh-mb-card-disc' }, '折扣') : null,
                React.createElement('span', { className: 'dsh-mb-card-name', title: m.name && m.name !== m.id ? m.name : m.id },
                  m.name && m.name !== m.id ? m.name : m.id),
                React.createElement('span', { className: 'dsh-mb-card-head-r' },
                  copiedId === m.id ? React.createElement('span', { className: 'dsh-mb-copied' }, '已复制') : null,
                  // 状态胶囊：纯平台状态（在线=绿点 / 测试中=琥珀点），官方 model-status-pill
                  // 画法；胶囊数据来自模型接口本身，不额外探测。
                  (() => {
                    if (!m.platformStatus) return null
                    const pillCls = m.platformStatus === 'online' ? ' on' : m.platformStatus === 'testing' ? ' testing' : ''
                    const txt = m.platformStatus === 'online' ? '在线' : m.platformStatus === 'testing' ? '测试中' : m.platformStatus
                    const dotCls = pillCls === ' on' ? ' ok' : pillCls === ' testing' ? ' deg' : ''
                    return React.createElement('span', { className: 'dsh-mb-card-status' + pillCls, title: '平台状态：' + txt },
                      React.createElement('i', { className: 'dsh-mb-card-status-dot' + dotCls }),
                      txt)
                  })())),
              React.createElement('div', { className: 'dsh-mb-card-sub' },
                React.createElement('span', { className: 'dsh-mb-card-id', title: m.id }, '模型 ID: ' + m.id),
                m.provider ? React.createElement('span', { className: 'dsh-mb-card-src', title: m.provider }, m.provider) : null),
            ),
            React.createElement('div', { className: 'dsh-mb-card-details' },
              React.createElement('dl', { className: 'dsh-mb-card-dl' },
                m.contextLength !== null ? React.createElement('div', { key: 'ctx' },
                  React.createElement('dt', null, '序列长度'),
                  React.createElement('dd', { title: '完整数值：' + m.contextLength + ' Token' }, fmtCtx(m.contextLength))) : null,
                Array.isArray(m.categories) && m.categories.length > 0 ? React.createElement('div', { key: 'mod' },
                  React.createElement('dt', null, '支持模态'),
                  React.createElement('dd', null, m.categories.map((c) => CAT_LABELS[c] || c).join(' / '))) : null,
                m.maxOutput !== null ? React.createElement('div', { key: 'maxout' },
                  React.createElement('dt', null, '最大输出长度'),
                  React.createElement('dd', { title: '完整数值：' + m.maxOutput + ' Token' }, fmtCtx(m.maxOutput))) : null),
              React.createElement('dl', { className: 'dsh-mb-card-dl' },
                m.inPrice !== null && m.inPrice !== undefined ? React.createElement('div', { key: 'in' },
                  React.createElement('dt', null, '输入单价'),
                  React.createElement('dd', null, priceCell(m.inPrice, m.hasDiscount ? m.effInPrice : null))) : null,
                m.outPrice !== null && m.outPrice !== undefined ? React.createElement('div', { key: 'out' },
                  React.createElement('dt', null, '输出单价'),
                  React.createElement('dd', null, priceCell(m.outPrice, m.hasDiscount ? m.effOutPrice : null))) : null,
                m.cachePrice !== null && m.cachePrice !== undefined ? React.createElement('div', { key: 'cache' },
                  React.createElement('dt', null, '缓存命中单价'),
                  React.createElement('dd', null, priceCell(m.cachePrice, m.hasDiscount ? m.effCachePrice : null))) : null,
                m.perImagePrice !== null && m.perImagePrice !== undefined ? React.createElement('div', { key: 'img' },
                  React.createElement('dt', null, '图片单价'),
                  React.createElement('dd', null, '¥' + trimNum(m.perImagePrice) + '/张')) : null)),
          ))),
        )
        rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'hint' }, '点击卡片复制模型 ID'))
      }
      return React.createElement('div', { className: 'dsh-mb-section' }, rows)
    }

    // ---- 密钥页签：本机凭据池（API Key + Cookie）——保存 / 列表 / 选用 / 删除 ----
    // 保存只入库、不改当前身份；列表把保存的原文完整展示出来（同源面板，仅本机可见）。
    function renderCredsTab({
      manifest, creds, loadCreds, credKey, setCredKey,
      credCookie, setCredCookie,
      credBusy, credTip, addCred, useCred, removeCred, copiedCred, copyCred,
    }) {
      const capable = manifest && Array.isArray(manifest.providers) && manifest.providers.some((p) => p.balanceCapable)
      if (!capable) {
        return React.createElement('div', { className: 'dsh-mb-notice' }, 'settings.yaml 里没有基元律动（tokenrhythm）提供商')
      }
      const rows = []
      const list = creds && Array.isArray(creds.list) ? creds.list : []
      const activeId = creds && creds.active ? creds.active : null
      // 保存表单：API Key 与 Cookie 两个等宽单行输入（至少一项）。只保存，选用在列表里点「使用」。
      const canSubmit = (credKey.trim() !== '' || credCookie.trim() !== '') && !credBusy
      rows.push(React.createElement('div', { className: 'dsh-mb-cred-form', key: 'form' },
        React.createElement('input', {
          className: 'dsh-mb-input dsh-mb-cred-input', type: 'text',
          placeholder: 'API Key（用于拉取模型清单，可留空）',
          value: credKey,
          onChange: (e) => setCredKey(e.target.value),
        }),
        React.createElement('input', {
          className: 'dsh-mb-input dsh-mb-cred-input', type: 'text',
          placeholder: 'Cookie（tr_session 的值，整段 Cookie 也认；用于查余额与用量，可留空）',
          value: credCookie,
          onChange: (e) => setCredCookie(e.target.value),
        }),
        React.createElement('button', { className: 'dsh-mb-btn', disabled: !canSubmit, onClick: addCred },
          credBusy ? '保存中…' : '保存'),
        credTip ? React.createElement('div', { className: 'dsh-mb-cookie-msg' + (credTip.ok ? '' : ' err') }, credTip.text) : null,
      ))
      if (creds === null || creds.loading) {
        // 骨架屏：凭据行 shimmer 占位。
        rows.push(React.createElement('div', { className: 'dsh-mb-skel-rows', key: 'ld', role: 'status', 'aria-label': '加载中' },
          [38, 62, 50, 56].map((w, i) => React.createElement('div', { className: 'dsh-mb-skel', key: i, style: { width: w + '%' } })),
        ))
      } else {
        if (creds.error) rows.push(React.createElement('div', { className: 'dsh-mb-notice err', key: 'err' }, '加载失败：' + creds.error))
        rows.push(React.createElement('div', { className: 'dsh-mb-keys-head', key: 'hd' },
          React.createElement('span', { className: 'dsh-mb-day-title', style: { marginTop: 0 } }, '已保存凭据（' + list.length + '）'),
          React.createElement('span', { className: 'dsh-mb-hint', style: { opacity: 1 } }, activeId ? '正在使用 1 条' : '未选用'),
        ))
        if (list.length === 0) {
          rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'empty' }, '还没有凭据：在上面填 API Key / Cookie 后点「保存」'))
        }
        rows.push(React.createElement('div', { className: 'dsh-mb-keys-list', key: 'ls' },
          list.map((c, i) => {
            // 完整展示保存的原文：Key 走 apiKey，Cookie 优先用粘贴原文（整段 Cookie 也照原样显示）；
            // 旧 host（尚未重启时只回掩码字段）退到掩码，最后才是「未填写」。
            const keyText = c.apiKey || c.apiKeyHint || ''
            const cookieText = c.cookieRaw || c.cookie || c.cookieHint || ''
            const keyCopied = copiedCred === c.id + ':key'
            const cookieCopied = copiedCred === c.id + ':cookie'
            const allCopied = copiedCred === c.id + ':all'
            return React.createElement('div', { className: 'dsh-mb-cred-card' + (c.active ? ' on' : ''), key: c.id || i },
              React.createElement('div', { className: 'dsh-mb-cred-body' },
                React.createElement('div', { className: 'dsh-mb-cred-line' },
                  React.createElement('span', { className: 'dsh-mb-cred-tag' }, 'Key'),
                  React.createElement('span', {
                    className: 'dsh-mb-cred-val' + (keyText === '' ? ' empty' : ''),
                    title: keyText || '未填写',
                  }, keyText === '' ? '（未填写）' : keyText),
                  React.createElement('button', {
                    className: 'dsh-mb-cred-copy', disabled: keyText === '', title: '复制 API Key',
                    onClick: () => copyCred(c, 'key'),
                  }, keyCopied ? '已复制' : '复制')),
                React.createElement('div', { className: 'dsh-mb-cred-line' },
                  React.createElement('span', { className: 'dsh-mb-cred-tag' }, 'Cookie'),
                  React.createElement('span', {
                    className: 'dsh-mb-cred-val' + (cookieText === '' ? ' empty' : ''),
                    title: cookieText || '未填写',
                  }, cookieText === '' ? '（未填写）' : cookieText),
                  React.createElement('button', {
                    className: 'dsh-mb-cred-copy', disabled: cookieText === '', title: '复制 Cookie',
                    onClick: () => copyCred(c, 'cookie'),
                  }, cookieCopied ? '已复制' : '复制')),
                // 这条凭据最后一次查询到的余额（host 在每次 /balance 成功时记在凭据上）。
                React.createElement('div', { className: 'dsh-mb-cred-bal' },
                  '最近余额 ',
                  c.lastBalance
                    ? React.createElement('span', { className: 'v' }, '¥' + fmtCny(c.lastBalance.cny))
                    : React.createElement('span', { className: 'v dim' }, '—'),
                  c.lastBalance
                    ? ' · ' + fmtCheckedAt(c.lastBalance.at)
                    : '（尚未查询）'),
              ),
              React.createElement('div', { className: 'dsh-mb-cred-actions' },
                React.createElement('button', {
                  className: 'dsh-mb-key-copy' + (c.active ? '' : ' primary'),
                  disabled: credBusy,
                  title: c.active
                    ? '当前使用中：点击停用（清空会话，并把 DSH 会话凭据还原为接管前的 Key）'
                    : '使用：模型清单与余额换用它的凭据，并把 API Key 写入 DSH 会话（新会话立即生效）',
                  onClick: () => useCred(c.active ? '' : c.id),
                }, c.active ? '当前' : '使用'),
                React.createElement('button', {
                  className: 'dsh-mb-key-copy', disabled: credBusy || (keyText === '' && cookieText === ''),
                  title: '复制整条凭据（API Key 与 Cookie 合成一段）',
                  onClick: () => copyCred(c, 'all'),
                }, allCopied ? '已复制' : '复制'),
                React.createElement('button', {
                  className: 'dsh-mb-key-copy danger', disabled: credBusy,
                  title: '删除该记录；若是当前使用项，同时解除它在模型与余额上的应用',
                  onClick: () => removeCred(c.id),
                }, '删除'),
              ),
            )
          }),
        ))
        // 旧 host（重启前只回掩码字段）→ 明确提示，避免误以为没保存上。
        const staleHost = list.some((c) => c.apiKey === undefined && c.apiKeyHint !== undefined)
        // DSH 会话凭据接管状态：选用带 Key 的凭据会写 .credentials.yaml（harness 热重载，新会话立即生效）。
        const dsh = creds && creds.dshKey ? creds.dshKey : null
        const dshNote = dsh && dsh.env
          ? (dsh.managed
            ? '已接管 DSH 会话凭据 ' + dsh.env + '：新会话立刻用当前凭据的 API Key；停用或删除即还原原值。'
            : '选用带 API Key 的凭据会把该 Key 写入 DSH 会话凭据 ' + dsh.env + '（新会话立即生效；停用 / 删除还原原值）。')
          : ''
        rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'hint' },
          staleHost
            ? '插件后台仍是旧版本（只回了掩码）：重启 DSH 后这里显示完整原文。'
            : '列表展示的是本机保存的原文（仅本机浏览器可见）；删除当前使用项后，模型与余额立即失去该凭据。',
          dshNote !== '' ? React.createElement('div', null, dshNote) : null,
          React.createElement('button', {
            className: 'dsh-mb-link', style: { marginLeft: 4 },
            onClick: () => { try { window.open('https://tokenrhythm.studio/account/keys', '_blank') } catch { /* 拦截无碍 */ } },
          }, '官网获取 Key ↗')))
      }
      return React.createElement('div', { className: 'dsh-mb-section' }, rows)
    }

    // ---- 余额页签：限时额度 hero + 当日使用（含缓存命中）+ 7 天趋势 + 最近调用 ----
    function renderBalanceTab({ manifest, balance, loadBalance, goSettings, goKeys, showCalls, setShowCalls, trendHoverIdx, setTrendHoverIdx, sessionAccount, sessionAccountName }) {
      const capable = manifest && Array.isArray(manifest.providers) && manifest.providers.some((p) => p.balanceCapable)
      if (!capable) {
        return React.createElement('div', { className: 'dsh-mb-notice' }, 'settings.yaml 里没有基元律动（tokenrhythm）提供商，无法查询余额')
      }
      const rows = []
      if (balance && balance.code === 'SESSION_EXPIRED') {
        rows.push(React.createElement('div', { className: 'dsh-mb-banner', key: 'expired' },
          '网页会话已过期：到 ',
          React.createElement('button', { className: 'dsh-mb-link', onClick: goKeys }, '密钥'),
          ' 页更新 Cookie，或到 ',
          React.createElement('button', { className: 'dsh-mb-link', onClick: goSettings }, '设置'),
          ' 用账号密码重新登录'))
      } else if (balance && balance.code === 'NO_SESSION') {
        rows.push(React.createElement('div', { className: 'dsh-mb-banner', key: 'nosess' },
          '尚未配置网页会话：到 ',
          React.createElement('button', { className: 'dsh-mb-link', onClick: goKeys }, '密钥'),
          ' 页录入 API Key / Cookie 后选用即可查余额'))
      } else if (balance && balance.error) {
        rows.push(React.createElement('div', { className: 'dsh-mb-notice err', key: 'err' }, '余额查询失败：' + balance.error))
      }
      // 首查加载：与主卡 / 当日使用同构的骨架屏占位（有数据或错误/会话提示时不再显示）。
      if (!balance || (balance.loading && !balance.data)) {
        rows.push(React.createElement('div', { className: 'dsh-mb-skel-hero', key: 'ld', role: 'status', 'aria-label': '加载中' },
          React.createElement('div', { className: 'dsh-mb-skel', style: { width: '40%', height: 30, borderRadius: 8 } }),
          React.createElement('div', { className: 'dsh-mb-skel', style: { width: '72%' } }),
          React.createElement('div', { className: 'dsh-mb-skel', style: { width: '100%', height: 7, borderRadius: 4 } }),
          React.createElement('div', { className: 'dsh-mb-skel', style: { width: '28%' } }),
        ))
        rows.push(React.createElement('div', { className: 'dsh-mb-skel-kv', key: 'ldkv' },
          Array.from({ length: 5 }, (_, i) => React.createElement('div', { className: 'dsh-mb-skel-kv-i', key: i },
            React.createElement('div', { className: 'dsh-mb-skel', style: { width: '40%' } }),
            React.createElement('div', { className: 'dsh-mb-skel', style: { width: '72%' } }),
          ))))
      }
      const d = balance && balance.data
      if (d) {
        // 预警条：临期 / 余额不足。
        const alert = alertOf(d)
        if (alert) {
          rows.push(React.createElement('div', { className: 'dsh-mb-banner', key: 'alert' },
            alert.expiring && alert.low
              ? '限时额度 ' + expiryLabel(alert.expiringDays) + '，且可用余额已不足 ¥10，尽快使用或充值'
              : alert.expiring
                ? '限时额度 ¥' + trimNum(alert.expiringBalanceCny) + '，' + expiryLabel(alert.expiringDays) + '，到期未用部分失效'
                : '可用余额仅剩 ¥' + trimNum(alert.availableBalanceCny) + '，建议充值'))
        }
        // 数据归属标注：余额/趋势都是「当前登录账号」的数据，切换账号会随之变化。
        // 显示平台用户名：优先 manifest.accountName（/api/me 提取，开面板即有），
        // 其次余额响应里的 account（同样来自 /api/me，每 60s 刷新）；
        // 都缺（/api/me 不可用）才回退登录标识 account（手机号）或 Cookie 模式文案。
        const dataAccount = sessionAccountName || (balance && balance.data && balance.data.account) || sessionAccount || null
        rows.push(React.createElement('div', { className: 'dsh-mb-acct-line' + (dataAccount ? '' : ' none'), key: 'acct' },
          React.createElement('span', { className: 'dsh-mb-acct-dot' }),
          '数据账号：' + (dataAccount || '未登录（Cookie 模式）'),
        ))
        // 主卡：账户余额为主位，限时额度副位（倒计时胶囊）+ 限时占比条 + 图例。
        const expiry = d.nextExpiryAt ? new Date(d.nextExpiryAt) : null
        const expiryValid = expiry !== null && !Number.isNaN(expiry.getTime())
        const expDays = expiryValid ? expiryDaysOf(expiry.getTime()) : null
        const chipText = expiryValid
          ? expiryLabel(expDays) + ' · ' + (expiry.getMonth() + 1) + '月' + expiry.getDate() + '日'
          : null
        const chipTitle = expiryValid
          ? expiry.getFullYear() + '-' + String(expiry.getMonth() + 1).padStart(2, '0') + '-' + String(expiry.getDate()).padStart(2, '0')
            + ' ' + String(expiry.getHours()).padStart(2, '0') + ':' + String(expiry.getMinutes()).padStart(2, '0') + ' 到期'
          : null
        const hasTotal = d.balanceCny !== null && d.balanceCny !== undefined
        const hasExpiring = d.expiringBalanceCny !== null && d.expiringBalanceCny !== undefined
        const share = hasTotal && hasExpiring && d.balanceCny > 0
          ? Math.min(1, Math.max(0, d.expiringBalanceCny / d.balanceCny))
          : null
        const legendBits = []
        if (share !== null) legendBits.push('限时占 ' + (Math.round(share * 1000) / 10) + '%')
        if (d.frozenBalanceCny) legendBits.push('冻结 ¥' + fmtCny(d.frozenBalanceCny))
        rows.push(React.createElement('div', { className: 'dsh-mb-hero', key: 'hero' },
          React.createElement('div', { className: 'dsh-mb-hero-stats' },
            React.createElement('div', { className: 'dsh-mb-stat' },
              React.createElement('span', { className: 'dsh-mb-stat-k' }, '账户余额'),
              React.createElement('span', { className: 'dsh-mb-stat-v' }, hasTotal ? '¥' + fmtCny(d.balanceCny) : '—'),
            ),
            hasExpiring ? React.createElement('div', { className: 'dsh-mb-stat right' },
              React.createElement('span', { className: 'dsh-mb-stat-k' }, '限时额度（到期失效）'),
              React.createElement('span', { className: 'dsh-mb-stat-v' }, '¥' + fmtCny(d.expiringBalanceCny)),
              chipText !== null ? React.createElement('span', {
                className: 'dsh-mb-hero-chip' + (expDays !== null && expDays <= 3 ? ' soon' : ''),
                title: chipTitle,
              }, chipText) : null,
            ) : null,
          ),
          share !== null ? React.createElement('div', { className: 'dsh-mb-hero-bar', title: chipTitle },
            React.createElement('div', { className: 'dsh-mb-hero-bar-fill', style: { width: (share * 100) + '%' } }),
          ) : null,
          legendBits.length > 0 ? React.createElement('div', { className: 'dsh-mb-hero-legend' },
            legendBits.map((bit, i) => React.createElement('span', { key: i }, bit)),
          ) : null,
        ))
        // 当日使用情况（与花费趋势同源：今天的 call-logs 分桶直读，数字必然一致；含缓存命中与命中率）。
        // 输入/输出合一张卡；缓存命中 + 命中率合一张卡。
        // 命中率口径（实测平台日志修正）：缓存命中 ÷ 输入。平台 call-logs 的
        // input_tokens【已包含】缓存命中部分（totalTokens = in + out 可证；费用
        // 反推 (in−缓存)×单价 + 缓存×缓存价 与 costCny 分毫不差），分母不再加缓存。
        const cacheHitRate = (day) => {
          const denom = day.inputTokens || 0
          if (denom <= 0) return '—'
          return trimNum(Math.round((day.cacheReadTokens || 0) / denom * 1000) / 10) + '%'
        }
        const day = d.daily
        rows.push(React.createElement('div', { className: 'dsh-mb-day-title', key: 'daytitle' }, '当日使用'))
        // 当日卡只在「分页真的缺页」（trendMeta.dailyPartial）时才提示：truncated 通常
        // 只是更早的日子没拉完（页序最新优先），今天的数字仍是全的，不必吓唬用户。
        if (d.trendMeta && d.trendMeta.dailyPartial) {
          rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'dayhint' },
            '当日日志分页拉取有失败，下方数字可能偏小，60s 内自动补齐'))
        }
        rows.push(React.createElement('div', { className: 'dsh-mb-kv-grid', key: 'kv' },
          [
            ['调用', day ? (day.calls + ' 次' + (day.calls > day.successCalls ? '（成功 ' + day.successCalls + '）' : '')) : '—'],
            ['输入 / 输出', day ? fmtTokens(day.inputTokens) + ' / ' + fmtTokens(day.outputTokens) : '—'],
            ['缓存命中 / 命中率', day ? fmtTokens(day.cacheReadTokens) + ' · ' + cacheHitRate(day) : '—', '缓存命中率 = 缓存命中 ÷ 输入（平台 input_tokens 已包含缓存命中部分）'],
            ['花费', day ? '¥' + trimNum(day.costCny) : '—'],
          ].map(([k, v, tip], i) => React.createElement('div', { className: 'dsh-mb-kv', key: i, title: tip || undefined },
            React.createElement('span', { className: 'dsh-mb-kv-k' }, k),
            React.createElement('span', { className: 'dsh-mb-kv-v' }, v)))),
        )
        // 花费趋势：最近 7 个有调用记录的日子（无记录日不留痕、不占柱位，与用量页 7 日图同口径）。
        // 柱顶直接标金额；「今天」高亮仅当最新有记录日就是今天；悬停浮出当日模型明细。
        // trendMeta.truncated：窗口/页数上限内没能凑齐完整的 7 个有记录日——注明仅统计
        // 最新 N 条，不装准。
        if (Array.isArray(d.trend) && d.trend.length > 0) {
          const meta = d.trendMeta && d.trendMeta.truncated ? d.trendMeta : null
          const max = Math.max.apply(null, d.trend.map((b) => b.costCny).concat([0.01]))
          const totalCost = d.trend.reduce((acc, b) => acc + b.costCny, 0)
          const totalCalls = d.trend.reduce((acc, b) => acc + b.calls, 0)
          const now = new Date()
          const todayLabel = (now.getMonth() + 1) + '-' + now.getDate()
          const lastDay = d.trend.length - 1
          rows.push(React.createElement('div', { className: 'dsh-mb-trend-wrap', key: 'trend' },
            React.createElement('div', { className: 'dsh-mb-day-title' },
              '花费 · 最近 ' + d.trend.length + ' 个有记录日 · 合计 ¥' + trimNum(totalCost) + ' · ' + totalCalls + ' 次'),
            meta ? React.createElement('div', { className: 'dsh-mb-hint' },
              '记录未完整拉取（仅统计最新 ' + meta.fetched + ' 条），金额与次数偏小仅作参考') : null,
            React.createElement('div', {
              className: 'dsh-mb-trend',
              onMouseLeave: () => setTrendHoverIdx(null),
            },
              d.trend.map((b, i) => {
                const models = Array.isArray(b.models) ? b.models : null
                const tipRows = models === null
                  ? [{ model: '暂无模型明细' }]
                  : models.length > 0 ? models : [{ model: '当天无调用' }]
                return React.createElement('div', {
                  className: 'dsh-mb-trend-col' + (b.date === todayLabel ? ' today' : ''),
                  key: i,
                  onMouseEnter: () => setTrendHoverIdx(i),
                },
                  React.createElement('span', { className: 'dsh-mb-trend-val' }, '¥' + trimNum(b.costCny)),
                  React.createElement('div', { className: 'dsh-mb-trend-bar', style: { height: Math.max(4, Math.round(b.costCny / max * 40)) + 'px' } }),
                  React.createElement('span', { className: 'dsh-mb-trend-date' }, b.date),
                  trendHoverIdx === i ? React.createElement('div', {
                    className: 'dsh-mb-trend-tip' + (i === 0 ? ' edge-l' : i === lastDay ? ' edge-r' : ''),
                  },
                    React.createElement('div', { className: 'dsh-mb-trend-tip-head' },
                      React.createElement('span', null, b.date),
                      React.createElement('span', null, '¥' + trimNum(b.costCny) + ' · ' + b.calls + ' 次'),
                    ),
                    tipRows.map((m, j) => React.createElement('div', { className: 'dsh-mb-trend-tip-row', key: j },
                      React.createElement('span', { className: 'dsh-mb-trend-tip-model' }, m.model),
                      m.costCny === undefined ? null : React.createElement('span', { className: 'dsh-mb-trend-tip-cost' }, '¥' + trimNum(m.costCny)),
                      m.calls === undefined ? null : React.createElement('span', { className: 'dsh-mb-trend-tip-calls' }, m.calls + ' 次'),
                    )),
                  ) : null,
                )
              }),
            ),
          ))
        }
        // 最近调用（24h 内最新 10 条，折叠列表；卡片化行列表 + 状态点晕 + 耗时/费用右对齐）。
        const recent = Array.isArray(d.recent) ? d.recent : []
        if (recent.length > 0) {
          rows.push(React.createElement('button', {
            className: 'dsh-mb-toggle', key: 'calls-toggle',
            onClick: () => setShowCalls(!showCalls),
          },
            (showCalls ? '▾' : '▸') + ' 最近调用',
            React.createElement('span', { className: 'dsh-mb-call-count' }, '24h · ' + recent.length + ' 条')))
          if (showCalls) {
            rows.push(React.createElement('div', { className: 'dsh-mb-calls', key: 'calls' },
              recent.map((c, i) => {
                const t = c.t ? new Date(c.t) : null
                const time = t && !Number.isNaN(t.getTime())
                  ? String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0')
                  : '--:--'
                const ok = c.status === 200
                return React.createElement('div', { className: 'dsh-mb-call' + (ok ? '' : ' err'), key: i, title: (c.model || '') + ' · 状态 ' + c.status + ' · ' + (c.latencyMs || 0) + 'ms' },
                  React.createElement('span', { className: 'dsh-mb-call-dot ' + (ok ? 'ok' : 'err') }),
                  React.createElement('span', { className: 'dsh-mb-call-time' }, time),
                  React.createElement('span', { className: 'dsh-mb-call-model' }, c.model || '—'),
                  React.createElement('span', { className: 'dsh-mb-call-lat' }, (c.latencyMs || 0) + 'ms'),
                  React.createElement('span', { className: 'dsh-mb-call-cost' + (c.costCny > 0 ? '' : ' zero') }, '¥' + trimNum(c.costCny)),
                )
              }),
            ))
          }
        }
      }
      rows.push(React.createElement('div', { className: 'dsh-mb-balance-foot', key: 'ft' },
        d
          ? '更新于 ' + new Date(d.fetchedAt).toLocaleTimeString() + ' · 每 60s 自动刷新' + (d.account ? ' · ' + d.account : '')
          : (balance && balance.loading ? '查询中…' : ''),
        React.createElement('button', { className: 'dsh-mb-refresh', onClick: loadBalance }, '刷新'),
      ))
      return React.createElement('div', { className: 'dsh-mb-section' }, rows)
    }

    // ---- ZCode「用量」页签：套餐额度英雄卡 + 分项限额。数据来自本机
    // ~/.zcode/v2 凭证 + zcode.z.ai / open.bigmodel.cn 官方接口（host 代理）。
    // 值格式：token 类大数用 万/亿 缩写，其余用 trimNum。 ----
    const zcFmtVal = (n) => {
      if (n === null || n === undefined || !Number.isFinite(n)) return '—'
      return Math.abs(n) >= 10000 ? fmtTokens(n) : trimNum(n)
    }
    function renderZcUsageTab({ zcQuota, loadZcQuota }) {
      const rows = []
      if (zcQuota === null || (zcQuota.loading && !zcQuota.data)) {
        rows.push(React.createElement('div', { className: 'dsh-mb-skel-hero', key: 'ld', role: 'status', 'aria-label': '加载中' },
          React.createElement('div', { className: 'dsh-mb-skel', style: { width: '40%', height: 30, borderRadius: 8 } }),
          React.createElement('div', { className: 'dsh-mb-skel', style: { width: '72%' } }),
          React.createElement('div', { className: 'dsh-mb-skel', style: { width: '100%', height: 7, borderRadius: 4 } }),
        ))
      } else if (zcQuota.error) {
        rows.push(React.createElement('div', { className: zcQuota.code === 'NO_CREDENTIALS' ? 'dsh-mb-notice' : 'dsh-mb-notice err', key: 'qerr' },
          zcQuota.code === 'NO_CREDENTIALS'
            ? '未找到 ZCode 登录凭证（~/.zcode/v2/credentials.json）——请先在 ZCode 客户端登录，再回到本页查看额度'
            : '额度查询失败：' + zcQuota.error,
          zcQuota.code !== 'NO_CREDENTIALS'
            ? React.createElement('div', { style: { marginTop: '6px' } },
              React.createElement('button', { className: 'dsh-mb-link', onClick: () => loadZcQuota(true) }, '重试'))
            : null))
      } else {
        const d = zcQuota.data
        const noPlan = d.source === 'no_plan' || (d.isEmpty === true && !d.planTier && (d.items || []).length === 0)
        if (noPlan) {
          rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'noplan' },
            '当前 ZCode 账号没有可展示的套餐额度（未订阅 coding plan 或额度为空）'))
        } else {
          const idLine = d.identity && (d.identity.name || d.identity.provider)
            ? 'ZCode 账号：' + (d.identity.name || '未知') + (d.identity.provider ? '（' + d.identity.provider + '）' : '')
            : null
          if (idLine !== null) {
            rows.push(React.createElement('div', { className: 'dsh-mb-acct-line', key: 'acct' },
              React.createElement('span', { className: 'dsh-mb-acct-dot' }), idLine))
          }
          const unit = ((d.items || []).find((i) => i.unit) || { unit: '' }).unit
          const hasRemaining = d.remaining !== null && d.remaining !== undefined
          const pct = d.percentUsed !== null && d.percentUsed !== undefined
            ? Math.min(100, Math.max(0, Math.round(d.percentUsed * 10) / 10))
            : null
          // 主位显示「剩余百分比」（与入口胶囊同口径），token 绝对值退居副行；
          // 无总量/百分比时回落 token 数直显。
          const remainPct = pct !== null ? Math.min(100, Math.max(0, Math.round((100 - pct) * 10) / 10)) : null
          const remainTxt = hasRemaining ? zcFmtVal(d.remaining) + (unit && unit !== 'quota' ? ' ' + unit : '') : null
          rows.push(React.createElement('div', { className: 'dsh-mb-hero', key: 'hero' },
            React.createElement('div', { className: 'dsh-mb-hero-stats' },
              React.createElement('div', { className: 'dsh-mb-stat' },
                React.createElement('span', { className: 'dsh-mb-stat-k' }, '剩余额度'),
                React.createElement('span', { className: 'dsh-mb-stat-v' },
                  remainPct !== null ? trimNum(remainPct) + '%' : (remainTxt || '—')),
                remainPct !== null && remainTxt !== null
                  ? React.createElement('span', { className: 'dsh-mb-stat-k' }, '≈ ' + remainTxt)
                  : null,
              ),
              React.createElement('div', { className: 'dsh-mb-stat right' },
                (d.planTier !== null && d.planTier !== undefined && d.planTier !== '') ? [
                  React.createElement('span', { className: 'dsh-mb-stat-k', key: 'k' }, '套餐'),
                  React.createElement('span', { className: 'dsh-mb-stat-v', key: 'v' }, d.planTier),
                  d.planExpire ? React.createElement('span', { className: 'dsh-mb-hero-chip', key: 'chip', title: '套餐到期时间' }, d.planExpire + ' 到期') : null,
                ] : null,
              ),
            ),
            pct !== null ? React.createElement('div', { className: 'dsh-mb-hero-bar', title: '已用 ' + pct + '%' },
              React.createElement('div', { className: 'dsh-mb-hero-bar-fill', style: { width: pct + '%' } }),
            ) : null,
            React.createElement('div', { className: 'dsh-mb-hero-legend' },
              React.createElement('span', null, pct !== null ? '已用 ' + pct + '%' : '已用 —'),
              React.createElement('span', null, (d.source === 'bigmodel.cn/api/monitor' || (d.source || '').includes('bigmodel')) ? '来源：open.bigmodel.cn' : '来源：zcode.z.ai'),
            ),
          ))
          // 分项限额（提示次数 / 时长 / 各模型 token 池）。
          const items = Array.isArray(d.items) ? d.items : []
          if (items.length > 0) {
            rows.push(React.createElement('div', { className: 'dsh-mb-kv-grid', key: 'items' },
              items.map((it, i) => React.createElement('div', { className: 'dsh-mb-kv', key: i, title: it.periodEnd || undefined },
                React.createElement('span', { className: 'dsh-mb-kv-k' }, it.name || '额度'),
                React.createElement('span', { className: 'dsh-mb-kv-v' },
                  (it.used !== null && it.used !== undefined ? zcFmtVal(it.used) : '—')
                  + (it.total !== null && it.total !== undefined ? ' / ' + zcFmtVal(it.total) : '')
                  + (it.unit && it.unit !== 'quota' ? ' ' + it.unit : '')),
                it.periodEnd ? React.createElement('span', { className: 'dsh-mb-kv-k' }, it.periodEnd) : null,
              ))))
          }
          rows.push(React.createElement('div', { className: 'dsh-mb-balance-foot', key: 'qfoot' },
            '更新于 ' + (d.fetchedAt ? new Date(d.fetchedAt).toLocaleTimeString() : '—') + ' · 每 60s 自动刷新' + (zcQuota.cached ? ' · 缓存' : ''),
            React.createElement('button', { className: 'dsh-mb-refresh', onClick: () => loadZcQuota(true) }, '刷新'),
          ))
        }
      }
      rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'hint' },
        '读取本机 ~/.zcode/v2 登录凭证 · 接口经插件后台代理 · 凭证只留在本机'))
      return React.createElement('div', { className: 'dsh-mb-section' }, rows)
    }

    // ---- ZCode「活动」页签：可领取套餐卡片 + 验证码弹窗领取（结果经 postMessage 回传）。
    function renderZcClaimTab({ zcPlans, loadZcPlans, zcMsg, claimZcodePlan }) {
      const rows = []
      if (zcMsg) {
        rows.push(React.createElement('div', { className: 'dsh-mb-cookie-msg' + (zcMsg.ok ? '' : ' err'), key: 'msg' }, zcMsg.text))
      }
      if (zcPlans === null || (zcPlans.loading && !zcPlans.list)) {
        rows.push(React.createElement('div', { className: 'dsh-mb-skel-rows', key: 'pld', role: 'status', 'aria-label': '加载中' },
          React.createElement('div', { className: 'dsh-mb-skel', style: { width: '62%' } }),
          React.createElement('div', { className: 'dsh-mb-skel', style: { width: '88%' } }),
        ))
      } else if (zcPlans.error) {
        rows.push(React.createElement('div', { className: 'dsh-mb-notice err', key: 'perr' },
          '活动列表加载失败：' + ((zcPlans.biz && zcPlans.biz.message) || zcPlans.error) + (zcPlans.biz && zcPlans.biz.nextAt
            ? '（' + new Date(zcPlans.biz.nextAt).toLocaleString() + ' 后可再领）' : ''),
          React.createElement('div', { style: { marginTop: '6px' } },
            React.createElement('button', { className: 'dsh-mb-link', onClick: loadZcPlans }, '重试'))))
      } else {
        const list = Array.isArray(zcPlans.list) ? zcPlans.list : []
        if (list.length === 0) {
          rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'pempty' }, '当前没有可领取的套餐'))
        } else {
          rows.push(React.createElement('div', { className: 'dsh-mb-keys-list', key: 'plist' },
            list.map((p) => React.createElement('div', { className: 'dsh-mb-key-card', key: p.planId },
              React.createElement('div', { className: 'dsh-mb-key-card-top' },
                React.createElement('span', { className: 'dsh-mb-key-card-name', title: p.description || p.name }, p.name || p.planId),
                React.createElement('button', { className: 'dsh-mb-key-copy primary', onClick: () => claimZcodePlan(p) }, '领取'),
              ),
              p.description ? React.createElement('div', { className: 'dsh-mb-key-card-meta' }, p.description) : null,
              p.grants && p.grants.length > 0 ? React.createElement('div', { className: 'dsh-mb-key-card-meta' }, p.grants.join('；')) : null,
            ))))
        }
        if (zcPlans.activationError) {
          rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'acterr' },
            '激活上报失败：' + zcPlans.activationError + '（不影响展示，领取可能受限）'))
        }
        rows.push(React.createElement('div', { className: 'dsh-mb-balance-foot', key: 'pfoot' },
          '领取需通过验证码 · 弹窗完成后自动提交',
          React.createElement('button', { className: 'dsh-mb-refresh', onClick: loadZcPlans }, '刷新'),
        ))
      }
      rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'hint' },
        '读取本机 ~/.zcode/v2 登录凭证 · 接口经插件后台代理 · 凭证只留在本机'))
      return React.createElement('div', { className: 'dsh-mb-section' }, rows)
    }

    // ---- 设置页签（右上角齿轮进入）：账号卡片 + 会话状态 + 入口胶囊 + ZCode + 关于 ----
    function renderSettingsTab({
      manifest, sessionConfigured, sessionAccount,
      accounts, addAcc, setAddAcc, addPw, setAddPw, showAddPw, setShowAddPw,
      accBusy, accMsg, addAccount, removeAccount, loginStored, showAccPw, setShowAccPw,
      updInfo, updBusy, loadUpdate, copyUpdateCmd, updCopied, ignoreUpdate,
      entryMode, setEntryBalance, zcEnabled, setZcodeEnabled, settingsTab, setSettingsTab,
    }) {
      const sessionValid = !!(manifest.session && manifest.session.valid)
      const pill = !sessionConfigured
        ? React.createElement('span', { className: 'dsh-mb-status-pill warn' },
            React.createElement('span', { className: 'dsh-mb-status-dot' }),
            '未登录')
        : (sessionValid
          ? React.createElement('span', { className: 'dsh-mb-status-pill ok' },
              React.createElement('span', { className: 'dsh-mb-status-dot' }),
              '已登录' + ((manifest.session && manifest.session.hint) ? ' · ' + manifest.session.hint : ''))
          : React.createElement('span', { className: 'dsh-mb-status-pill warn' },
              React.createElement('span', { className: 'dsh-mb-status-dot' }),
              '会话已过期 · 自动重登未成功，请重新登录'))
      // 分组页签：设置卡按「账号 / 胶囊 / ZCode / 关于」归类，避免一长条。
      const settingsTabs = [['tr', '基元'], ['zcode', 'ZCode'], ['about', '关于']]
      return React.createElement('div', { className: 'dsh-mb-section' },
        React.createElement('div', { className: 'dsh-mb-seg-line', style: { flexWrap: 'wrap' } },
          settingsTabs.map(([id, label]) => React.createElement('button', {
            key: id,
            className: 'dsh-mb-cat' + (settingsTab === id ? ' active' : ''),
            onClick: () => setSettingsTab(id),
          }, label))),
        ...(settingsTab === 'tr' ? [
        // 账号卡片
        React.createElement('div', { className: 'dsh-mb-set-card', key: 'account' },
          React.createElement('div', { className: 'dsh-mb-set-title' }, '账号管理'),
          React.createElement('div', { className: 'dsh-mb-set-desc' },
            '添加基元律动账号，登录后即可查看余额、用量和密钥。密码保存在本机，随时可以查看；支持多个账号随时切换。'),
          React.createElement('div', { className: 'dsh-mb-acc-form' },
            React.createElement('input', {
              className: 'dsh-mb-input', style: { minHeight: 0, padding: '6px 10px' },
              placeholder: '账号（手机号）',
              value: addAcc,
              onChange: (e) => setAddAcc(e.target.value),
            }),
            React.createElement('div', { className: 'dsh-mb-pw-wrap' },
              React.createElement('input', {
                className: 'dsh-mb-input', style: { minHeight: 0, padding: '6px 10px' },
                type: showAddPw ? 'text' : 'password',
                placeholder: '密码',
                value: addPw,
                onChange: (e) => setAddPw(e.target.value),
              }),
              React.createElement('button', {
                className: 'dsh-mb-pw-eye', title: showAddPw ? '隐藏密码' : '显示密码',
                onClick: () => setShowAddPw(!showAddPw),
              }, EyeIcon({ off: showAddPw })),
            ),
            React.createElement('button', {
              className: 'dsh-mb-btn', disabled: accBusy || addAcc.trim() === '' || addPw === '',
              onClick: addAccount,
            }, accBusy ? '处理中…' : '添加并登录'),
          ),
          accMsg ? React.createElement('div', { className: 'dsh-mb-cookie-msg' + (accMsg.ok ? '' : ' err') }, accMsg.text) : null,
          accounts !== null && accounts.length > 0
            ? React.createElement('div', { className: 'dsh-mb-acc-list' },
              accounts.map((a) => {
                const cur = sessionAccount !== null && sessionAccount !== undefined
                  ? String(sessionAccount).toLowerCase() === a.account.toLowerCase()
                  : false
                return React.createElement('div', { className: 'dsh-mb-acc-row' + (cur ? ' cur' : ''), key: a.account },
                  React.createElement('span', { className: 'dsh-mb-acc-avatar' }, a.account.slice(0, 1).toUpperCase()),
                  React.createElement('div', { className: 'dsh-mb-acc-info' },
                    React.createElement('div', { className: 'dsh-mb-acc-name' },
                      a.account,
                      cur ? React.createElement('span', { className: 'dsh-mb-acc-cur' }, '当前') : null),
                    React.createElement('div', { className: 'dsh-mb-acc-pw' },
                      showAccPw === a.account ? a.password : '••••••••'),
                  ),
                  React.createElement('button', {
                    className: 'dsh-mb-key-copy icon', title: showAccPw === a.account ? '隐藏密码' : '显示密码',
                    onClick: () => setShowAccPw(showAccPw === a.account ? null : a.account),
                  }, EyeIcon({ off: showAccPw === a.account })),
                  React.createElement('button', {
                    className: 'dsh-mb-key-copy' + (cur ? ' primary' : ''), disabled: accBusy || cur,
                    title: cur ? '已是当前登录账号' : '切换到此账号登录',
                    onClick: () => loginStored(a.account),
                  }, cur ? '登录中' : '登录'),
                  React.createElement('button', {
                    className: 'dsh-mb-key-copy danger', disabled: accBusy,
                    onClick: () => removeAccount(a.account),
                  }, '删除'),
                )
              }))
            : null,
        ),
        // 会话状态卡片
        React.createElement('div', { className: 'dsh-mb-set-card', key: 'session' },
          React.createElement('div', { className: 'dsh-mb-status-row' },
            React.createElement('span', { className: 'dsh-mb-kv-k' }, '当前会话'),
            pill,
          ),
        ),
        ] : []),
        ...(settingsTab === 'tr' ? [
        // 布局与「插件更新」卡一致：标题行 + 内容行（说明靠左，按钮组贴右）。
        React.createElement('div', { className: 'dsh-mb-set-card', key: 'pillbase' },
          React.createElement('div', { className: 'dsh-mb-set-title' }, '入口胶囊余额'),
          React.createElement('div', { className: 'dsh-mb-seg-line' },
            React.createElement('span', { className: 'dsh-mb-seg-desc' }, '侧栏入口右侧胶囊显示的金额'),
            React.createElement('span', { className: 'dsh-mb-seg-row' },
              React.createElement('button', {
                className: 'dsh-mb-cat' + (entryMode === 'total' ? ' active' : ''),
                onClick: () => setEntryBalance('total'),
              }, '总余额'),
              React.createElement('button', {
                className: 'dsh-mb-cat' + (entryMode === 'expiring' ? ' active' : ''),
                onClick: () => setEntryBalance('expiring'),
              }, '限时总余额'),
            ),
          ),
        ),
        ] : []),
        ...(settingsTab === 'zcode' ? [
        // ---- ZCode 集成卡：默认关闭。开启后面板标题切换器出现 ZCode 段，
        // 插件后台才允许读取 ~/.zcode/v2 凭证并直连官方接口。----
        React.createElement('div', { className: 'dsh-mb-set-card', key: 'zcode' },
          React.createElement('div', { className: 'dsh-mb-set-title' }, 'ZCode 集成'),
          React.createElement('div', { className: 'dsh-mb-seg-line' },
            React.createElement('span', { className: 'dsh-mb-seg-desc' },
              '读取本机 ~/.zcode/v2 登录凭证，展示 ZCode 套餐额度并可领取活动（默认关闭）'),
            React.createElement('span', { className: 'dsh-mb-seg-row' },
              React.createElement('button', {
                className: 'dsh-mb-cat' + (zcEnabled ? ' active' : ''),
                onClick: () => setZcodeEnabled(true),
              }, '开启'),
              React.createElement('button', {
                className: 'dsh-mb-cat' + (!zcEnabled ? ' active' : ''),
                onClick: () => setZcodeEnabled(false),
              }, '关闭'),
            ),
          ),
          zcEnabled ? React.createElement('div', { className: 'dsh-mb-hint' },
            '已开启：切换器出现「ZCode」段。凭证只在插件后台内存使用，浏览器不见明文；关闭即停读') : null,
        ),
        ] : []),
        ...(settingsTab === 'about' ? [
        // 插件更新卡片（npm dist-tags 比对）。只提醒不自动执行：宿主进程占用
        // node_modules 时自动重装有 EPERM 风险，复制命令由用户手动跑最稳。
        // 单行布局：版本 + 模式徽标 + 状态靠左，操作按钮靠右（用户定稿一行放不下
        // 不截断——状态过长时省略号，按钮组在极窄面板才整体换行）。
        React.createElement('div', { className: 'dsh-mb-set-card', key: 'about' },
          React.createElement('div', { className: 'dsh-mb-set-title' }, '插件更新'),
          React.createElement('div', { className: 'dsh-mb-upd-line' },
            React.createElement('span', { className: 'dsh-mb-upd-cur' },
              'v' + ((updInfo && updInfo.current) || (manifest && manifest.version) || '…')),
            updInfo && updInfo.installMode === 'local'
              ? React.createElement('span', { className: 'dsh-mb-upd-mode' }, '本地开发模式')
              : null,
            React.createElement('span', { className: 'dsh-mb-upd-state' + (updInfo && updInfo.updateAvailable ? ' new' : '') },
              updInfo === null ? (updBusy ? '正在检查更新…' : '—')
                : updInfo.latest === null || updInfo.latest === undefined ? (updInfo.error || '暂无版本信息')
                : updInfo.updateAvailable ? '有新版本 v' + updInfo.latest + (updInfo.checkedAt ? '（' + fmtCheckedAt(updInfo.checkedAt) + ' 检测）' : '')
                : (updInfo.ignoredVersion && updInfo.ignoredVersion === updInfo.latest) ? '已忽略 v' + updInfo.latest + ' 的更新提示'
                : '已是最新版本' + (updInfo.checkedAt ? '（' + fmtCheckedAt(updInfo.checkedAt) + ' 检测）' : '')),
            React.createElement('span', { className: 'dsh-mb-upd-actions' },
              React.createElement('button', {
                className: 'dsh-mb-btn small', disabled: updBusy,
                onClick: () => loadUpdate(true),
              }, updBusy ? '检查中…' : '检查更新'),
              updInfo && updInfo.updateAvailable
                ? React.createElement('button', {
                  className: 'dsh-mb-btn small ghost', onClick: copyUpdateCmd, title: '复制 dsh plugin add dsh-tokenrhythm-bill',
                }, updCopied ? '已复制 ✓' : '复制更新命令')
                : null,
              updInfo && updInfo.updateAvailable
                ? React.createElement('button', {
                  className: 'dsh-mb-btn small ghost', onClick: ignoreUpdate, title: '不再提示此版本',
                }, '忽略此版本')
                : null,
            ),
          ),
        ),
        ] : []),
      )
    }

    const inject = ['slots'];
    function apply(ctx) {
      const slots = ctx.get('slots');
      if (slots === undefined) return;

      ctx.effect(() => {
        const styleEl = document.createElement('style');
        styleEl.setAttribute('data-plugin', 'dsh-tokenrhythm-bill');
        styleEl.textContent = PANEL_CSS;
        document.head.appendChild(styleEl);
        return () => { if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl); };
      });

      // 预警轮询：每 5 分钟查一次余额（面板关着也查），临期/低余额点亮入口琥珀点；
      // 同时刷新入口常驻总余额（balanceCny）。会话未配置/失效时清空两者。
      ctx.effect(() => {
        let timer = null
        let stopped = false
        const check = async () => {
          if (stopped) return
          const m = await jsonGet(API + '/manifest')
          if (!m || !m.ok || !m.session || !m.session.configured) {
            setStore({ alert: null, balanceCny: null, expiringItems: [] })
            return
          }
          // 入口胶囊显示模式等轻量偏好：随轮询同步（面板从未打开也能生效）。
          const p = await jsonGet(API + '/prefs')
          if (p && p.ok && p.prefs && (p.prefs.entryBalance === 'total' || p.prefs.entryBalance === 'expiring')) {
            setStore({ entryBalMode: p.prefs.entryBalance })
          }
          const b = await jsonGet(API + '/balance')
          if (b && b.ok) {
            setStore({
              alert: alertOf(b),
              balanceCny: b.balanceCny !== null && b.balanceCny !== undefined ? b.balanceCny : null,
              expiringItems: Array.isArray(b.expiringItems) ? b.expiringItems : [],
            })
          }
        }
        const start = () => {
          check()
          timer = setInterval(check, 5 * 60 * 1000)
        }
        start()
        return () => { stopped = true; if (timer !== null) clearInterval(timer) }
      }, 'tokenrhythm-bill: alert poll');

      // 侧栏条目行：DSH 侧栏中部没有可注册的官方槽位，因此按「记忆系统 / 技能中心」同族
      // （它们也是 DOM 注入）的做法注入，并自愈 React 重渲染：始终排在这些同族条目之后。
      // 性能约束（宿主 DOM 变动极频繁）：只做去抖调度 + 廉价早退，绝不重复全文档查询或
      // 递归 textContent；任何异常都吞掉，宁可不注入也不能拖垮宿主前端。
      ctx.effect(() => {
        let host = null
        let root = null
        let rootEl = null
        let timer = null
        let retryTimer = null
        let observer = null
        const FAMILY_SELECTOR = '[data-dsh-part="sidebar-entry"],[data-dsh-mnemon-entry],[data-dsh-taskboard-entry],[data-dsh-ssh-entry]'
        const ANCHOR_TEXTS = ['记忆系统', '技能中心']
        const findSidebarRoot = () => document.querySelector('[data-pane="sidebar"]') || document.querySelector('[class*="sidebarCol"]')
        const newSessionButton = (el) => {
          const nested = el.querySelector('button[class*="newSession"]')
          if (nested !== null) return nested
          for (const child of el.children) if (child.tagName === 'BUTTON') return child
          return null
        }
        // 锚点行只有两类：同族条目，或「直接子级 ≤3 的按钮」且文本命中记忆系统/技能中心
        // —— 后者避免对大子树递归取 textContent。
        const isAnchorRow = (el) => {
          if (!(el instanceof HTMLElement) || el === host) return false
          if (el.matches(FAMILY_SELECTOR)) return true
          if (el.tagName !== 'BUTTON' || el.children.length > 3) return false
          const text = el.textContent || ''
          return ANCHOR_TEXTS.some((t) => text.includes(t))
        }
        // 廉价早退判据：只看自己后面的兄弟节点，有没有需要越过的锚点行。
        const hasLaterAnchor = (parent) => {
          for (let el = host.nextElementSibling; el !== null; el = el.nextElementSibling) {
            if (isAnchorRow(el)) return true
          }
          return false
        }
        const place = () => {
          if (rootEl === null || !rootEl.isConnected) return false
          const button = newSessionButton(rootEl)
          if (button === null) return false
          const row = button.closest('[class*="logoRow"]')
          const base = row !== null && row.parentElement === rootEl ? row : button
          const parent = base.parentElement ?? rootEl
          let anchorEl = null
          for (const el of parent.children) if (isAnchorRow(el)) anchorEl = el
          const next = anchorEl !== null ? anchorEl.nextElementSibling : base.nextElementSibling
          const target = next !== null && next !== undefined && next.parentElement === parent && next !== host ? next : null
          const cur = host.nextElementSibling
          const same = host.parentElement === parent && ((target === null && cur === null) || cur === target)
          if (!same) parent.insertBefore(host, target)
          return true
        }
        const sync = () => {
          try {
            if (host === null || root === null) return
            if (rootEl !== null && !rootEl.isConnected) rootEl = null
            if (rootEl === null) rootEl = findSidebarRoot()
            if (rootEl === null) return
            if (host.parentElement !== null && !hasLaterAnchor(host.parentElement)) return // 已就位
            place()
          } catch { /* 宿主结构变化中的瞬态错误：忽略，等下一次调度 */ }
        }
        const schedule = () => {
          if (timer !== null) return
          timer = setTimeout(() => { timer = null; sync() }, 200)
        }
        let cancelled = false
        const start = () => {
          if (cancelled) return
          try {
            host = document.createElement('div')
            host.setAttribute('data-dsh-plugin', 'dsh-tokenrhythm-bill')
            host.setAttribute('data-dsh-part', 'sidebar-entry')
            if (ReactDOMClient !== null) {
              root = ReactDOMClient.createRoot(host)
              root.render(React.createElement(EntryRow))
            }
            observer = new MutationObserver(schedule)
            observer.observe(document.body, { childList: true, subtree: true })
            sync()
            // 记忆系统 / 技能中心可能稍后才挂载：启动后再校正一次，确保排到它们下方。
            retryTimer = setTimeout(() => { rootEl = null; sync() }, 1200)
          } catch (err) {
            try { console.warn('[dsh-tokenrhythm-bill] sidebar entry injection failed:', err) } catch { /* noop */ }
          }
        }
        // 排障开关：环境变量 DSH_TOKENRHYTHM_NO_SIDEBAR=1（host 经 /prefs 暴露）时不注入
        // 侧栏条目，面板本体照常加载——侧栏注入一旦出问题，不用卸载插件就能排除它。
        jsonGet(API + '/prefs').then((r) => {
          if (cancelled) return
          if (r && r.ok && r.sidebarEntry === false) return
          start()
        })
        return () => {
          cancelled = true
          if (timer !== null) clearTimeout(timer)
          if (retryTimer !== null) clearTimeout(retryTimer)
          if (observer !== null) observer.disconnect()
          if (root !== null) { try { root.unmount() } catch { /* 已卸载 */ } }
          if (host !== null && host.parentNode !== null) host.remove()
        }
      }, 'tokenrhythm-bill: sidebar entry');

      ctx.effect(() => slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'tokenrhythm-bill-panel', order: 30 },
        () => React.createElement(Panel),
      )), 'tokenrhythm-bill: overlay panel');
    }

    exports.apply = apply;
    exports.inject = inject;

    // ---- CSS：全量挂 DSH 设计令牌（--dsw-alias-* / --ds-*，由 dsh-client-ui-theme 定义在
    // body 上），明暗主题经 body[data-ds-dark-theme] 自动跟随；不再有本地配色主题。
    // --mb-* 只是短别名桥接层，var() 第二参为令牌缺失时的保守回退。 ----
    const PANEL_CSS = `
      /* .dsh-mb-hov 是入口按钮的兄弟节点（fixed 悬浮卡），必须自己挂变量桥接层，
       * 否则 var(--mb-panelBg) 等解析为空 → 背景透明。 */
      .dsh-mb-panel,[data-dsh-part="sidebar-entry"],.dsh-mb-hov{
        --mb-font:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",Helvetica,Arial,sans-serif);
        --mb-codeFont:var(--ds-font-family-code,"SF Mono","JetBrains Mono","Fira Code",Consolas,"Liberation Mono",Menlo,Courier,"PingFang SC","Microsoft YaHei",monospace);
        --mb-panelBg:var(--dsw-alias-bg-layer-2,#fff);
        --mb-line:var(--dsw-alias-border-l2,rgba(0,0,0,.102));
        --mb-lineSoft:var(--dsw-alias-border-l1,rgba(0,0,0,.039));
        --mb-soft:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.059));
        --mb-card:var(--dsw-alias-bg-layer-1,#fff);
        --mb-txt:var(--dsw-alias-label-primary,#0f1115);
        --mb-sub:var(--dsw-alias-label-secondary,#81858c);
        --mb-tert:var(--dsw-alias-label-tertiary,#979da6);
        --mb-dim:var(--dsw-alias-label-dimmed,#dcdcdc);
        --mb-acc:var(--dsw-alias-state-business-primary,#4176e6);
        --mb-btnFill:var(--dsw-alias-button-primary-fill,#0f1115);
        --mb-btnHover:var(--dsw-alias-button-primary-hover,#3c3c3d);
        --mb-btnTx:var(--dsw-alias-label-primary-foreground,#fff);
        --mb-elev:var(--dsw-alias-button-elevated-fill,#fff);
        --mb-float:var(--dsw-alias-button-floating-hover,#e5f0ff);
        --mb-ghostFill:var(--dsw-alias-button-ghost-active-fill,#e9ecf2);
        --mb-ghostLine:var(--dsw-alias-button-ghost-active-border,#979da6);
        --mb-ok:var(--dsw-alias-state-success-primary,#22c55e);
        --mb-warn:var(--dsw-alias-state-warn-primary,#f59e0b);
        --mb-warnTx:var(--dsw-alias-state-warn-label,#dd8629);
        --mb-err:var(--dsw-alias-state-error-primary,#ec1313);
        --mb-inputBg:var(--dsw-alias-bg-layer-1,#fff);
        --mb-inputLine:var(--dsw-alias-border-l2,rgba(0,0,0,.102));
        --mb-focus:var(--dsw-alias-brand-primary,#0f1115);
        --mb-codeBg:var(--dsw-alias-markdown-inline-code,#ebeef2);
        --mb-codeBlock:var(--dsw-alias-markdown-code-block,#f9fafb);
        --mb-ease:var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1));
        --mb-fast:var(--ds-transition-duration-fast,.1s);
        --mb-dur:var(--ds-transition-duration,.2s);
      }

      /* 侧栏条目行（注入到「记忆系统 / 技能中心」下方）：对齐官方侧栏行的几何
       * （min-height 36 / padding 7px 8px / radius 8），右侧常驻余额胶囊。 */
      .dsh-mb-nav-row{position:relative;box-sizing:border-box;display:flex;align-items:center;gap:8px;
        width:100%;min-height:36px;padding:7px 8px;border:none;border-radius:8px;background:transparent;
        cursor:pointer;text-align:left;color:var(--mb-sub);font-family:var(--mb-font);
        font-size:14px;font-weight:400;line-height:22px;
        transition:background-color var(--mb-fast) var(--mb-ease),color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-nav-row:hover{background:var(--mb-soft)}
      .dsh-mb-nav-row.active{background:var(--mb-soft);color:var(--mb-txt);font-weight:500}
      .dsh-mb-nav-icon{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px}
      .dsh-mb-nav-icon svg{display:block}
      .dsh-mb-dot{position:absolute;top:-2px;right:-3px;width:7px;height:7px;border-radius:50%;background:var(--mb-warn);
        box-shadow:0 0 0 2px color-mix(in srgb, var(--mb-warn) 30%, transparent)}
      .dsh-mb-nav-label{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .dsh-mb-nav-bal{flex:none;margin-left:auto;padding:2px 8px;border-radius:999px;font-variant-numeric:tabular-nums;
        color:var(--mb-acc);font-size:11.5px;font-weight:600;letter-spacing:.2px;white-space:nowrap;
        background:color-mix(in srgb,var(--mb-acc) 10%,transparent)}
      .dsh-mb-nav-bal.alert{color:var(--mb-warnTx);background:color-mix(in srgb,var(--mb-warn) 12%,transparent)}
      /* 入口悬浮卡：限时余额逐笔（金额 + N 天后失效）。fixed 定位贴视口、由 JS 按
       * 入口 rect 计算位置（宽态行上方右对齐 / rail 态同式，钳制在视口内）；
       * 进卡片不断链，移开 150ms 收起；整卡可点击打开面板。 */
      .dsh-mb-hov{position:fixed;z-index:10001;box-sizing:border-box;padding:10px 12px;
        background:var(--mb-panelBg);color:var(--mb-txt);font-family:var(--mb-font);
        border:1px solid var(--dsw-alias-border-inverted,rgba(0,0,0,.06));border-radius:12px;
        box-shadow:var(--dsw-shadow-lv2,0 8px 24px rgba(0,0,0,.16));
        font-size:12px;line-height:1.5;cursor:pointer;user-select:none;
        animation:dsh-mb-hov-in var(--mb-fast) var(--mb-ease)}
      @keyframes dsh-mb-hov-in{0%{opacity:0}}
      .dsh-mb-hov-head{font-weight:600;color:var(--mb-sub);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .dsh-mb-hov-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:3px 0;font-variant-numeric:tabular-nums}
      .dsh-mb-hov-amt{font-weight:600;font-size:13px}
      .dsh-mb-hov-days{color:var(--mb-sub);white-space:nowrap}
      .dsh-mb-hov-item.soon .dsh-mb-hov-amt{color:var(--mb-warnTx)}
      .dsh-mb-hov-item.soon .dsh-mb-hov-days{color:var(--mb-warnTx);font-weight:600}
      /* 侧栏收起（宿主给 frame 打 data-sidebar-collapsed）：只留 36×36 圆形图标。 */
      [data-sidebar-collapsed] .dsh-mb-nav-row{width:36px;height:36px;min-height:36px;justify-content:center;
        gap:0;padding:0;margin:0 auto}
      [data-sidebar-collapsed] .dsh-mb-nav-label,
      [data-sidebar-collapsed] .dsh-mb-nav-bal{display:none}

      /* 浮层：实色 layer-2 + inverted 描边 + 桌面设置弹窗同款投影（DSH 无磨砂卡面）。 */
      .dsh-mb-panel{position:fixed;z-index:10000;display:flex;flex-direction:column;
        max-height:min(80vh,760px);box-sizing:border-box;
        background:var(--mb-panelBg);color:var(--mb-txt);font-family:var(--mb-font);
        border:1px solid var(--dsw-alias-border-inverted,rgba(0,0,0,.06));border-radius:16px;
        box-shadow:0 24px 64px color-mix(in srgb, #000 38%, transparent);
        overflow:hidden;font-size:13px;line-height:1.5}
      .dsh-mb-head{flex:none;display:flex;align-items:center;justify-content:space-between;height:44px;padding:0 8px 0 14px;
        border-bottom:1px solid var(--mb-lineSoft);cursor:grab;user-select:none;touch-action:none}
      .dsh-mb-head:active{cursor:grabbing}
      .dsh-mb-head-title{font-weight:500;font-size:14px;letter-spacing:.2px;color:var(--mb-txt)}
      .dsh-mb-head-actions{display:flex;align-items:center;gap:2px}
      /* 头部左侧组：原标题（任何模式保留）+ 提供商切换器（ZCode 开启时紧贴标题出现） */
      .dsh-mb-head-left{display:flex;align-items:center;gap:10px;min-width:0}
      /* 标题位提供商切换器（基元律动｜ZCode）：轨道段样式与页签条同语言，开启 ZCode 时顶替标题出现 */
      .dsh-mb-prov{display:flex;gap:3px;padding:3px;border-radius:10px;background:var(--mb-soft)}
      .dsh-mb-prov-btn{border:none;background:transparent;cursor:pointer;padding:4px 12px;border-radius:8px;
        color:var(--mb-sub);font-size:12.5px;font-weight:500;font-family:inherit;
        transition:background-color var(--mb-fast) var(--mb-ease),color var(--mb-fast) var(--mb-ease),box-shadow var(--mb-fast) var(--mb-ease)}
      .dsh-mb-prov-btn:hover{color:var(--mb-txt);background:var(--dsw-alias-interactive-bg-hover-accent,rgba(38,49,72,.14))}
      .dsh-mb-prov-btn.active{color:var(--mb-txt);font-weight:600;background:var(--mb-panelBg);box-shadow:inset 0 0 0 1px var(--mb-line)}
      .dsh-mb-iconbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;
        border:none;border-radius:8px;background:transparent;cursor:pointer;color:var(--mb-sub);font-size:14px;
        transition:background-color var(--mb-fast) var(--mb-ease),color var(--mb-fast) var(--mb-ease),box-shadow var(--mb-fast) var(--mb-ease)}
      .dsh-mb-iconbtn:hover{background:var(--mb-soft);color:var(--mb-txt)}
      .dsh-mb-iconbtn.active{background:var(--mb-ghostFill);color:var(--mb-txt);box-shadow:inset 0 0 0 1px var(--mb-ghostLine)}
      /* 页签条：轨道用淡填充（DSH active 导航项的 ~6-8% 填充画法），激活页签用面板
       * 同色「凸起」+ border-l2 细描边，明暗两套主题都清晰。 */
      .dsh-mb-tabs{flex:none;display:flex;gap:4px;margin:10px 14px 0;padding:3px;border-radius:10px;
        background:var(--mb-soft)}
      .dsh-mb-tab{flex:1;border:none;background:transparent;cursor:pointer;padding:5px 0;border-radius:8px;
        color:var(--mb-sub);font-size:12.5px;font-weight:500;font-family:inherit;
        transition:background-color var(--mb-fast) var(--mb-ease),color var(--mb-fast) var(--mb-ease),box-shadow var(--mb-fast) var(--mb-ease)}
      .dsh-mb-tab:hover{color:var(--mb-txt);
        background:var(--dsw-alias-interactive-bg-hover-accent,rgba(38,49,72,.14))}
      .dsh-mb-tab.active{color:var(--mb-txt);font-weight:600;
        background:var(--mb-panelBg);box-shadow:inset 0 0 0 1px var(--mb-line)}
      .dsh-mb-body{flex:1;min-height:0;overflow-y:auto;padding:10px 14px 14px}
      .dsh-mb-section{display:flex;flex-direction:column;gap:8px}

      .dsh-mb-notice{padding:14px 10px;text-align:center;color:var(--mb-sub)}
      .dsh-mb-notice.err{color:var(--mb-err)}
      /* 加载骨架屏：与真实内容同构的 shimmer 占位（soft 底 + 文字色 8% 微光扫过，
       * 尊重系统减动效设置）。 */
      .dsh-mb-skel{position:relative;overflow:hidden;flex:none;height:12px;border-radius:6px;background:var(--mb-soft)}
      .dsh-mb-skel::after{content:"";position:absolute;inset:0;transform:translateX(-100%);
        background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--mb-txt) 8%,transparent),transparent);
        animation:dsh-mb-shimmer 1.4s var(--mb-ease) infinite}
      @keyframes dsh-mb-shimmer{100%{transform:translateX(100%)}}
      .dsh-mb-skel-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px}
      .dsh-mb-skel-card{display:flex;flex-direction:column;gap:8px;padding:10px 12px;
        border:1px solid var(--mb-lineSoft);border-radius:12px}
      .dsh-mb-skel-hero{display:flex;flex-direction:column;gap:10px;padding:14px 16px;
        border:1px solid var(--mb-lineSoft);border-radius:12px;background:var(--mb-card)}
      .dsh-mb-skel-kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px}
      .dsh-mb-skel-kv-i{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:10px;
        background:var(--mb-card);border:1px solid var(--mb-lineSoft)}
      .dsh-mb-skel-rows{display:flex;flex-direction:column;gap:12px;padding:4px 2px}
      @media (prefers-reduced-motion:reduce){.dsh-mb-skel::after{animation:none}}
      .dsh-mb-banner{display:flex;align-items:center;gap:2px;padding:8px 10px;border-radius:10px;font-size:12px;
        background:color-mix(in srgb, var(--mb-warn) 10%, transparent);
        border:1px solid color-mix(in srgb, var(--mb-warn) 35%, transparent);color:var(--mb-warnTx)}
      .dsh-mb-link{border:none;background:transparent;cursor:pointer;padding:0 2px;font-size:12px;font-weight:600;font-family:inherit;
        color:var(--mb-acc);text-decoration:underline}

      /* 分类筛选 chips：Pill 规格（h24/r12/12px），激活态 ghost 填充 + 内描边。 */
      /* 分类筛选行滚动固定：sticky 钉在滚动容器顶部。top/margin-top 各 -10px 抵消
       * body 的 padding-top，钉住时靠 14px 上内边距盖住原间隙——滚动内容不再从
       * 头部与筛选行之间透出。负 margin 铺满左右内边距并垫面板实色底；缓存标签
       * margin-left:auto 靠行最右，放不下时横向滚动（隐藏滚动条）。 */
      .dsh-mb-cats{position:sticky;top:-10px;z-index:2;display:flex;flex-wrap:nowrap;align-items:center;gap:6px;
        margin:-10px -14px 0;padding:14px 14px 6px;background:var(--mb-panelBg);overflow-x:auto;scrollbar-width:none}
      .dsh-mb-cats::-webkit-scrollbar{display:none}
      .dsh-mb-cache-tag{flex:none;margin-left:auto;font-size:11px;line-height:24px;padding:0 8px;border-radius:12px;
        color:var(--mb-sub);background:var(--mb-soft)}
      .dsh-mb-cache-tag.stale{color:var(--mb-warnTx);background:color-mix(in srgb,var(--mb-warn) 12%,transparent)}
      .dsh-mb-cat{cursor:pointer;border:none;height:24px;display:inline-flex;align-items:center;border-radius:12px;
        padding:0 8px;font-size:12px;line-height:18px;font-family:inherit;background:transparent;color:var(--mb-sub);
        transition:background-color var(--mb-fast) var(--mb-ease),color var(--mb-fast) var(--mb-ease),box-shadow var(--mb-fast) var(--mb-ease)}
      .dsh-mb-cat:hover{background:var(--mb-soft);color:var(--mb-txt)}
      .dsh-mb-cat.active{background:var(--mb-ghostFill);
        color:var(--mb-txt);font-weight:600;box-shadow:inset 0 0 0 1px var(--mb-ghostLine)}
      .dsh-mb-cat-count{opacity:.7;font-size:11px;margin-left:1px;font-variant-numeric:tabular-nums}
      .dsh-mb-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px}
      /* 模型卡片：DSH 淡填充（interactive-bg-hover）+ 细描边 + shadow-lv1 抬升，
       * hover 加深到 accent 填充 + border-l2 + shadow-lv2，浅色下面板与卡片分离明显。 */
      .dsh-mb-card{padding:10px 12px;border:1px solid var(--mb-lineSoft);border-radius:12px;
        background:var(--mb-soft);cursor:pointer;box-shadow:var(--dsw-shadow-lv1,0 2px 4px rgba(0,0,0,.05));
        transition:border-color var(--mb-fast) var(--mb-ease),background-color var(--mb-fast) var(--mb-ease),box-shadow var(--mb-fast) var(--mb-ease)}
      /* 折扣徽章：标题行最左（内容区左上角），实底绿渐变 + 白字醒目；
       * 行内排布随行高走，卡片布局零影响。 */
      .dsh-mb-card-disc{flex:none;margin-right:6px;font-size:10px;font-weight:700;line-height:16px;
        letter-spacing:1px;padding:0 8px;border-radius:6px;color:#fff;
        background:linear-gradient(135deg,color-mix(in srgb,var(--mb-ok) 78%,#000),var(--mb-ok));
        box-shadow:0 1px 3px color-mix(in srgb,var(--mb-ok) 35%,transparent)}
      .dsh-mb-card:hover{border-color:var(--mb-line);
        background:var(--dsw-alias-interactive-bg-hover-accent,rgba(38,49,72,.14));
        box-shadow:var(--dsw-shadow-lv2,0 4px 12px rgba(0,0,0,.05))}
      .dsh-mb-card.copied{border-color:var(--mb-ok)}
      .dsh-mb-copied{font-size:10px;font-weight:600;color:var(--mb-ok)}
      .dsh-mb-hint{font-size:10.5px;color:var(--mb-sub);text-align:center;opacity:.85}
      .dsh-mb-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .dsh-mb-card-name{flex:1 1 auto;min-width:0;font-weight:700;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mb-txt)}
      .dsh-mb-card-head-r{flex:none;display:inline-flex;align-items:center;gap:6px}
      /* 状态胶囊（官方 model-status-pill）：纯平台状态——在线=绿点 / 测试中=琥珀点，
       * 圆点颜色跟随胶囊色调（dotCls 由 pillCls 派生），无平台状态不渲染。 */
      .dsh-mb-card-status{flex:none;display:inline-flex;align-items:center;gap:4px;font-size:10px;line-height:16px;
        padding:0 7px;border-radius:8px;background:var(--mb-soft);color:var(--mb-sub)}
      .dsh-mb-card-status-dot{width:6px;height:6px;border-radius:50%;background:var(--mb-tert)}
      .dsh-mb-card-status-dot.ok{background:var(--mb-ok)}
      .dsh-mb-card-status-dot.deg{background:var(--mb-warn)}
      .dsh-mb-card-status-dot.fail{background:var(--mb-err)}
      .dsh-mb-card-status.on{color:var(--mb-ok);background:color-mix(in srgb,var(--mb-ok) 12%,transparent)}
      .dsh-mb-card-status.testing{color:var(--mb-warnTx);background:color-mix(in srgb,var(--mb-warn) 12%,transparent)}
      .dsh-mb-card-status.err{color:var(--mb-err);background:color-mix(in srgb,var(--mb-err) 12%,transparent)}
      .dsh-mb-card-sub{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:10.5px;color:var(--mb-sub);overflow:hidden;margin-top:1px}
      .dsh-mb-card-id{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-card-src{flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      /* details：规格 + 价格两栏（官方 model-spec-list / model-price-list 布局）。 */
      .dsh-mb-card-details{display:flex;gap:6px 18px;flex-wrap:wrap;margin-top:8px}
      .dsh-mb-card-dl{flex:1 1 150px;min-width:145px;margin:0;display:flex;flex-direction:column;gap:3px}
      .dsh-mb-card-dl > div{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
      .dsh-mb-card-dl dt{flex:none;color:var(--mb-sub);font-size:11px}
      .dsh-mb-card-dl dd{margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        font-weight:600;font-size:11.5px;text-align:right;color:var(--mb-txt);font-variant-numeric:tabular-nums}
      .dsh-mb-card-price-old{margin-right:4px;font-size:10.5px;font-weight:500;color:var(--mb-tert);text-decoration:line-through}
      .dsh-mb-badge{font-size:10px;padding:1px 6px;border-radius:6px;background:var(--mb-soft);color:var(--mb-sub)}
      .dsh-mb-badge.disc{color:var(--mb-ok)}
      .dsh-mb-badge.on{color:var(--mb-ok)}
      .dsh-mb-badge.off{color:var(--mb-tert)}

      /* 余额 hero：品牌蓝 7% 淡底 + 25% 描边（color-mix 跟随主题），数字纯色不再渐变。 */
      /* 余额主卡：品牌蓝淡底定位「钱」卡，双列统计（账户余额为主）+ 倒计时胶囊 +
       * 限时占比条；颜色全走令牌桥，明暗自动跟随。 */
      .dsh-mb-acct-line{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--mb-sub);padding:2px 2px 0}
      .dsh-mb-acct-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--mb-ok)}
      .dsh-mb-acct-line.none .dsh-mb-acct-dot{background:var(--mb-warn)}
      .dsh-mb-hero{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border-radius:12px;
        border:1px solid color-mix(in srgb, var(--mb-acc) 25%, transparent);
        background:color-mix(in srgb, var(--mb-acc) 7%, transparent)}
      .dsh-mb-hero-stats{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
      .dsh-mb-stat{display:flex;flex-direction:column;gap:2px;min-width:0}
      .dsh-mb-stat.right{align-items:flex-end;text-align:right}
      .dsh-mb-stat-k{font-size:12px;color:var(--mb-sub)}
      .dsh-mb-stat-v{font-size:28px;font-weight:600;line-height:1.15;white-space:nowrap;
        font-variant-numeric:tabular-nums;color:var(--mb-txt)}
      .dsh-mb-stat.right .dsh-mb-stat-v{font-size:20px}
      .dsh-mb-hero-chip{display:inline-flex;align-items:center;margin-top:2px;padding:1px 8px;border-radius:999px;
        font-size:11px;font-weight:600;line-height:16px;
        color:var(--mb-sub);background:var(--mb-soft)}
      .dsh-mb-hero-chip.soon{color:var(--mb-warnTx);
        background:color-mix(in srgb, var(--mb-warn) 12%, transparent)}
      .dsh-mb-hero-bar{display:flex;height:6px;border-radius:3px;overflow:hidden;
        background:color-mix(in srgb, var(--mb-sub) 18%, transparent)}
      .dsh-mb-hero-bar-fill{height:100%;min-width:2px;background:var(--mb-warn)}
      .dsh-mb-hero-legend{display:flex;align-items:center;justify-content:space-between;gap:8px;
        font-size:11px;color:var(--mb-sub);font-variant-numeric:tabular-nums}
      .dsh-mb-day-title{font-size:12px;font-weight:600;color:var(--mb-sub);margin-top:2px}
      .dsh-mb-kv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px}
      .dsh-mb-kv{display:flex;flex-direction:column;gap:1px;padding:8px 10px;border-radius:10px;
        background:var(--mb-soft);border:1px solid var(--mb-lineSoft)}
      .dsh-mb-kv-k{font-size:11px;color:var(--mb-sub)}
      .dsh-mb-kv-v{font-size:13px;font-weight:600;color:var(--mb-txt);font-variant-numeric:tabular-nums}
      .dsh-mb-trend-wrap{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:10px;
        background:var(--mb-soft);border:1px solid var(--mb-lineSoft)}
      .dsh-mb-trend{display:flex;align-items:flex-end;gap:5px;height:78px;padding:0 2px}
      .dsh-mb-trend-col{position:relative;flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0;height:100%;justify-content:flex-end}
      .dsh-mb-trend-val{font-size:9.5px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--mb-txt)}
      .dsh-mb-trend-col.today .dsh-mb-trend-val{color:var(--mb-acc)}
      .dsh-mb-trend-bar{width:100%;max-width:28px;border-radius:4px 4px 2px 2px;
        background:color-mix(in srgb, var(--mb-sub) 45%, transparent)}
      .dsh-mb-trend-col.today .dsh-mb-trend-bar{background:var(--mb-acc)}
      .dsh-mb-trend-col:hover .dsh-mb-trend-bar{background:var(--mb-acc)}
      .dsh-mb-trend-date{font-size:9.5px;color:var(--mb-sub);white-space:nowrap}
      /* 悬停气泡：对齐原生 Tooltip.module.css（tooltip-bg 深底 + 白字、r8、150ms 淡入、
       * pointer-events:none）；首/末列用 edge 类防出面板。 */
      .dsh-mb-trend-tip{position:absolute;z-index:20;bottom:calc(100% + 14px);left:50%;transform:translateX(-50%);
        min-width:170px;max-width:250px;box-sizing:border-box;padding:8px 10px;border-radius:8px;text-align:left;
        background:var(--dsw-alias-tooltip-bg,#283142);color:var(--dsw-static-neutral-bluish-00,#fff);
        box-shadow:var(--dsw-shadow-lv2,0 4px 12px rgba(0,0,0,.05));pointer-events:none;
        display:flex;flex-direction:column;gap:3px;font-size:11px;line-height:17px;
        animation:dsh-mb-tip-in 150ms var(--mb-ease)}
      .dsh-mb-trend-tip.edge-l{left:0;transform:none}
      .dsh-mb-trend-tip.edge-r{left:auto;right:0;transform:none}
      .dsh-mb-trend-tip-head{display:flex;align-items:center;justify-content:space-between;gap:8px;
        padding-bottom:3px;margin-bottom:1px;border-bottom:1px solid rgba(255,255,255,.08);
        color:var(--dsw-static-neutral-bluish-300,#cfd3d6);font-weight:600}
      .dsh-mb-trend-tip-row{display:flex;align-items:center;gap:8px}
      .dsh-mb-trend-tip-model{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-trend-tip-cost{flex:none;font-weight:600;font-variant-numeric:tabular-nums}
      .dsh-mb-trend-tip-calls{flex:none;color:var(--dsw-static-neutral-bluish-400,#adb2b8);font-variant-numeric:tabular-nums}
      @keyframes dsh-mb-tip-in{from{opacity:0}}
      .dsh-mb-toggle{align-self:flex-start;border:none;background:transparent;cursor:pointer;padding:2px 0;
        font-size:12px;font-weight:600;color:var(--mb-sub);font-family:inherit;
        transition:color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-toggle:hover{color:var(--mb-txt)}
      .dsh-mb-calls{display:flex;flex-direction:column;border:1px solid var(--mb-lineSoft);border-radius:10px;padding:2px 0;overflow:hidden}
      /* 调用行：去掉逐行灰底，改为发丝分隔 + 悬停浮起；错误行淡红可扫读。 */
      .dsh-mb-call{display:flex;align-items:center;gap:8px;font-size:11.5px;padding:5px 10px;
        transition:background var(--mb-fast) var(--mb-ease)}
      .dsh-mb-call + .dsh-mb-call{border-top:1px solid color-mix(in srgb,var(--mb-lineSoft) 60%,transparent)}
      .dsh-mb-call:hover{background:var(--mb-soft)}
      .dsh-mb-call.err{background:color-mix(in srgb,var(--mb-err) 5%,transparent)}
      .dsh-mb-call-dot{flex:none;width:6px;height:6px;border-radius:50%}
      .dsh-mb-call-dot.ok{background:var(--mb-ok);
        box-shadow:0 0 0 2.5px color-mix(in srgb,var(--mb-ok) 18%,transparent)}
      .dsh-mb-call-dot.err{background:var(--mb-err);
        box-shadow:0 0 0 2.5px color-mix(in srgb,var(--mb-err) 20%,transparent)}
      .dsh-mb-call-time{flex:none;width:34px;color:var(--mb-tert);font-variant-numeric:tabular-nums}
      .dsh-mb-call-model{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mb-txt);font-weight:500}
      .dsh-mb-call-lat{flex:none;color:var(--mb-tert);font-size:10.5px;font-variant-numeric:tabular-nums}
      .dsh-mb-call-cost{flex:none;min-width:44px;text-align:right;font-weight:600;color:var(--mb-txt);font-variant-numeric:tabular-nums}
      .dsh-mb-call-cost.zero{color:var(--mb-tert);font-weight:500}
      .dsh-mb-call-count{margin-left:6px;font-size:10px;font-weight:600;color:var(--mb-sub);
        border:1px solid var(--mb-lineSoft);border-radius:5px;padding:0 6px;line-height:15px}
      .dsh-mb-balance-foot{display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--mb-sub)}
      .dsh-mb-refresh{cursor:pointer;border:1px solid var(--mb-line);border-radius:8px;font-family:inherit;
        background:transparent;color:var(--mb-txt);padding:3px 12px;font-size:12px;
        transition:background-color var(--mb-fast) var(--mb-ease),border-color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-refresh:hover{background:var(--mb-soft);border-color:var(--mb-ghostLine)}

      .dsh-mb-set-title{font-weight:600;font-size:13px;color:var(--mb-txt)}
      .dsh-mb-set-desc{font-size:12px;color:var(--mb-sub)}
      /* 插件更新卡片：单行——版本 + 模式徽标 + 状态靠左，操作按钮靠右。
       * 状态过长省略号截断；actions 整组 flex:none，极窄面板时随 wrap 换行。 */
      .dsh-mb-upd-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .dsh-mb-upd-cur{font-family:var(--mb-codeFont);font-size:12px;font-weight:600;color:var(--mb-txt);flex:none}
      .dsh-mb-upd-mode{font-size:11px;color:var(--mb-sub);flex:none;
        border:1px solid var(--mb-lineSoft);border-radius:999px;padding:0 8px;line-height:18px}
      .dsh-mb-upd-state{font-size:12px;color:var(--mb-sub);flex:1 1 auto;min-width:0;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-upd-state.new{color:var(--mb-acc);font-weight:600}
      .dsh-mb-upd-actions{margin-left:auto;display:flex;gap:8px;flex:none}
      .dsh-mb-btn.small{height:24px;padding:0 12px;font-size:12px;font-weight:500;border-radius:12px}
      /* 入口胶囊余额：骨架与「插件更新」卡一致——标题行 + 内容行（说明靠左、
       * 按钮组贴右）；复用 .dsh-mb-cat 的 chip/active 样式，极窄面板才换行。 */
      .dsh-mb-seg-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .dsh-mb-seg-desc{font-size:12px;color:var(--mb-sub);flex:1 1 auto;min-width:0;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-seg-row{margin-left:auto;display:flex;gap:8px;flex:none}
      /* 设置卡背景是 --mb-soft，与 .active 的 ghost 填充几乎同色 → 选中态隐形。
       * seg 行内改用 accent 描边 + accent 文字，任何底色上都一眼可辨。 */
      .dsh-mb-seg-row .dsh-mb-cat.active{background:color-mix(in srgb,var(--mb-acc) 10%,transparent);
        color:var(--mb-acc);font-weight:600;box-shadow:inset 0 0 0 1px var(--mb-acc)}
      .dsh-mb-code{font-family:var(--mb-codeFont);font-size:11px;
        background:var(--mb-codeBg);color:var(--mb-txt);border-radius:4px;padding:0 4px}
      .dsh-mb-session-row{display:flex;align-items:center;gap:8px;font-size:12px}
      .dsh-mb-ok{color:var(--mb-ok);font-weight:500}
      .dsh-mb-warn{color:var(--mb-warnTx);font-weight:500}
      .dsh-mb-input{width:100%;box-sizing:border-box;resize:vertical;min-height:56px;padding:8px 10px;border-radius:8px;font-size:12px;
        font-family:var(--mb-codeFont);
        border:1px solid var(--mb-inputLine);background:var(--mb-inputBg);color:var(--mb-txt);
        transition:border-color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-input:focus{outline:none;border-color:var(--mb-focus)}
      .dsh-mb-input::placeholder{color:var(--mb-dim)}
      .dsh-mb-btn-row{display:flex;gap:8px}
      .dsh-mb-btn{cursor:pointer;border:none;border-radius:16px;height:32px;padding:0 16px;font-size:13px;font-weight:600;font-family:inherit;
        background:var(--mb-btnFill);color:var(--mb-btnTx);
        transition:background-color var(--mb-fast) var(--mb-ease),opacity var(--mb-fast) var(--mb-ease)}
      .dsh-mb-btn:hover:not(:disabled){background:var(--mb-btnHover)}
      .dsh-mb-btn:disabled{opacity:.4;cursor:not-allowed}
      .dsh-mb-btn.ghost{background:transparent;color:var(--mb-txt);border:1px solid var(--mb-line)}
      .dsh-mb-btn.ghost:hover:not(:disabled){background:var(--mb-soft)}
      .dsh-mb-cookie-msg{font-size:12px;color:var(--mb-sub)}
      .dsh-mb-cookie-msg.err{color:var(--mb-err)}
      .dsh-mb-key-list{display:flex;flex-direction:column;gap:4px}
      .dsh-mb-key-row{display:flex;align-items:center;gap:8px;font-size:12px;padding:4px 0;
        border-bottom:1px dashed var(--mb-lineSoft)}
      .dsh-mb-key-name{font-weight:600;min-width:64px;color:var(--mb-txt)}
      .dsh-mb-key-copy{margin-left:auto;flex:none;cursor:pointer;border:1px solid var(--mb-line);border-radius:8px;font-family:inherit;
        background:transparent;color:var(--mb-txt);padding:2px 10px;font-size:11px;
        transition:background-color var(--mb-fast) var(--mb-ease),border-color var(--mb-fast) var(--mb-ease),opacity var(--mb-fast) var(--mb-ease)}
      .dsh-mb-key-copy:hover:not(:disabled){background:var(--mb-soft)}
      .dsh-mb-key-copy:disabled{opacity:.4;cursor:not-allowed}
      .dsh-mb-key-copy.icon{display:inline-flex;align-items:center;justify-content:center;
        width:26px;height:20px;padding:0;color:var(--mb-sub)}
      .dsh-mb-resize{position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;touch-action:none;
        background:linear-gradient(135deg, transparent 50%, var(--mb-sub) 45%)}
      /* 设置弹窗：覆盖整个面板的模态层——纯色压暗遮罩（遵守 DSH 实色卡面规范，
       * 不用磨砂玻璃）+ 居中卡片（头部 + 滚动体）；点遮罩空白 / ✕ / Esc 关闭；
       * z-index 压过 sticky 筛选行(z=2)。 */
      .dsh-mb-panel.settings-open{border-color:transparent}
      .dsh-mb-modal{position:absolute;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;
        padding:12px;background:color-mix(in srgb, var(--mb-txt) 28%, transparent);
        border-radius:inherit;overflow:hidden;
        animation:dsh-mb-tip-in 150ms var(--mb-ease)}
      .dsh-mb-modal-card{width:100%;max-width:640px;height:100%;display:flex;flex-direction:column;overflow:hidden;
        border-radius:12px;background:var(--mb-panelBg);
        box-shadow:var(--dsw-shadow-lv2,0 6px 18px rgba(0,0,0,.12))}
      .dsh-mb-modal-head{flex:none;display:flex;align-items:center;justify-content:space-between;height:42px;
        padding:0 8px 0 14px;border-bottom:1px solid var(--mb-lineSoft)}
      .dsh-mb-modal-title{font-weight:500;font-size:14px;letter-spacing:.2px;color:var(--mb-txt)}
      .dsh-mb-modal-body{flex:1;min-height:0;overflow-y:auto;padding:10px 14px 14px}

      /* 密钥页签：保存表单（两个等宽单行输入 + 全宽保存键）/ 凭据卡片（左两行原文，右删除·使用）。 */
      .dsh-mb-cred-form{display:flex;flex-direction:column;gap:8px;
        border:1px solid var(--mb-lineSoft);border-radius:12px;padding:12px;background:var(--mb-card)}
      .dsh-mb-cred-input{min-height:0;padding:7px 10px}
      .dsh-mb-cred-form .dsh-mb-btn{width:100%}
      .dsh-mb-cred-card{position:relative;display:flex;align-items:stretch;gap:12px;padding:10px 12px 10px 14px;
        border:1px solid var(--mb-lineSoft);border-radius:12px;background:var(--mb-card)}
      /* 当前使用的凭据：左侧品牌色竖条 + 描边。 */
      .dsh-mb-cred-card.on{border-color:color-mix(in srgb,var(--mb-acc) 45%,transparent);
        background:color-mix(in srgb,var(--mb-acc) 6%,var(--mb-card))}
      .dsh-mb-cred-card.on::before{content:"";position:absolute;left:0;top:9px;bottom:9px;width:3px;
        border-radius:0 3px 3px 0;background:var(--mb-acc)}
      .dsh-mb-cred-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:7px;justify-content:center}
      .dsh-mb-cred-line{display:flex;align-items:flex-start;gap:8px;min-width:0}
      .dsh-mb-cred-tag{flex:none;width:50px;text-align:center;padding:1px 0;border-radius:5px;
        font-size:10.5px;font-weight:600;color:var(--mb-sub);background:var(--mb-soft)}
      .dsh-mb-cred-card.on .dsh-mb-cred-tag{background:color-mix(in srgb,var(--mb-acc) 14%,transparent);color:var(--mb-acc)}
      /* 保存的原文完整展示：长串按字符换行，不截断。 */
      .dsh-mb-cred-val{flex:1;min-width:0;font-family:var(--mb-codeFont);font-size:11.5px;line-height:1.5;
        color:var(--mb-txt);word-break:break-all}
      .dsh-mb-cred-val.empty{color:var(--mb-dim);font-family:inherit}
      /* 凭据卡片底部：这条凭据最后一次查到的余额 + 时间。 */
      .dsh-mb-cred-bal{margin-top:1px;font-size:10.5px;color:var(--mb-sub)}
      .dsh-mb-cred-bal .v{font-weight:600;color:var(--mb-txt);font-variant-numeric:tabular-nums}
      .dsh-mb-cred-bal .v.dim{color:var(--mb-dim);font-weight:500}
      /* 行内小复制键：细体文字链，不抢视觉。 */
      .dsh-mb-cred-copy{flex:none;border:none;background:transparent;cursor:pointer;padding:0 2px;font-family:inherit;
        font-size:10.5px;color:var(--mb-acc);text-decoration:underline}
      .dsh-mb-cred-copy:hover:not(:disabled){color:var(--mb-txt)}
      .dsh-mb-cred-copy:disabled{color:var(--mb-dim);cursor:not-allowed;text-decoration:none}
      .dsh-mb-cred-actions{flex:none;display:flex;flex-direction:column;justify-content:center;gap:6px}
      .dsh-mb-cred-actions .dsh-mb-key-copy{width:58px;text-align:center;margin:0}
      .dsh-mb-keys-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .dsh-mb-keys-list{display:flex;flex-direction:column;gap:6px}
      .dsh-mb-key-card{padding:9px 12px;border:1px solid var(--mb-lineSoft);border-radius:12px;background:var(--mb-soft)}
      .dsh-mb-key-card-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .dsh-mb-key-card-name{font-weight:600;font-size:12.5px;color:var(--mb-txt)}
      .dsh-mb-key-card .dsh-mb-key-copy{flex:none}
      .dsh-mb-key-card-meta{font-size:10.5px;color:var(--mb-sub);margin-top:3px}
      /* 设置页：分区卡片 + 账号行（头像字/当前徽标/明文切换）。 */
      .dsh-mb-set-card{border:1px solid var(--mb-lineSoft);border-radius:12px;background:var(--mb-soft);
        padding:12px;display:flex;flex-direction:column;gap:8px}
      .dsh-mb-status-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .dsh-mb-status-pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;
        padding:2px 10px;border-radius:999px}
      .dsh-mb-status-pill.ok{color:var(--mb-ok);background:color-mix(in srgb, var(--mb-ok) 10%, transparent)}
      .dsh-mb-status-pill.warn{color:var(--mb-warnTx);background:color-mix(in srgb, var(--mb-warn) 12%, transparent)}
      .dsh-mb-status-dot{width:7px;height:7px;border-radius:50%;background:currentColor}
      .dsh-mb-acc-form{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
      .dsh-mb-acc-form .dsh-mb-input{flex:1;min-width:130px}
      .dsh-mb-acc-form .dsh-mb-btn{flex:none}
      .dsh-mb-pw-wrap{position:relative;display:flex;flex:1;min-width:150px}
      .dsh-mb-pw-wrap .dsh-mb-input{flex:1;padding-right:34px}
      .dsh-mb-pw-eye{position:absolute;right:3px;top:50%;transform:translateY(-50%);cursor:pointer;
        display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;
        border:none;background:transparent;color:var(--mb-acc);border-radius:6px;
        transition:background-color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-pw-eye:hover{background:var(--mb-soft)}
      .dsh-mb-acc-list{display:flex;flex-direction:column;gap:4px}
      .dsh-mb-acc-row{display:flex;align-items:center;gap:8px;font-size:12px;padding:7px 9px;border-radius:10px;
        background:var(--mb-panelBg);border:1px solid var(--mb-lineSoft)}
      .dsh-mb-acc-row.cur{border-color:var(--mb-ok)}
      .dsh-mb-acc-avatar{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;
        border-radius:8px;background:var(--mb-ghostFill);color:var(--mb-txt);font-weight:600;font-size:12px}
      .dsh-mb-acc-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
      .dsh-mb-acc-name{font-weight:600;color:var(--mb-txt);display:flex;align-items:center;gap:6px;min-width:0}
      .dsh-mb-acc-cur{flex:none;font-size:9.5px;font-weight:600;color:var(--mb-ok);background:color-mix(in srgb, var(--mb-ok) 10%, transparent);
        border-radius:5px;padding:0 5px}
      .dsh-mb-acc-pw{font-family:var(--mb-codeFont);font-size:10.5px;color:var(--mb-sub);
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-key-copy.primary{color:var(--mb-btnTx);background:var(--mb-btnFill);border-color:var(--mb-btnFill);font-weight:600}
      .dsh-mb-key-copy.primary:hover:not(:disabled){background:var(--mb-btnHover)}
      .dsh-mb-key-copy.danger{color:var(--mb-err);border-color:color-mix(in srgb, var(--mb-err) 40%, transparent)}

      @media (prefers-reduced-motion:reduce){.dsh-mb-nav-row,.dsh-mb-trend-tip,.dsh-mb-hov{transition:none;animation:none}}
`;
        return module.exports;
  }
});
