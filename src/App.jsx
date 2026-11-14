import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Check, ChevronRight, CircleDot, Clock3, Copy, Download, FileSpreadsheet, LogOut, QrCode, Search, Share2, ShieldCheck, Sparkles, Trash2, X } from 'lucide-react'
import QRCode from 'qrcode'
import { apiCall, ensureAnonymousSession, isSupabaseConfigured, supabase } from './supabase'
import './App.css'
import './theme.css'

const statusText = { unanswered: 'Awaiting answer', answered: 'Answered' }

function reportError(context, error) {
  console.error(`[MicMe] ${context}`, error)
}

async function copyTextToClipboard(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return
    }
  } catch {
    // Fall back for browsers or contexts that block the Clipboard API.
  }

  const textArea = document.createElement('textarea')
  const previousFocus = document.activeElement
  textArea.value = value
  textArea.setAttribute('readonly', '')
  textArea.style.position = 'fixed'
  textArea.style.top = '-1000px'
  textArea.style.left = '-1000px'
  document.body.append(textArea)
  try {
    textArea.focus()
    textArea.select()
    textArea.setSelectionRange(0, textArea.value.length)
    if (!document.execCommand('copy')) throw new Error('The browser could not copy the access code.')
  } finally {
    textArea.remove()
    previousFocus?.focus?.()
  }
}

function ActionDialog({ dialog, onClose, saving = false }) {
  const [copyFeedback, setCopyFeedback] = useState(null)
  const [confirmError, setConfirmError] = useState(null)
  const confirmRef = useRef(null)

  useEffect(() => {
    if (!dialog) return undefined
    confirmRef.current?.focus()
    const closeOnEscape = event => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [dialog, onClose, saving])

  if (!dialog) return null
  const isPin = dialog.kind === 'pin'
  const copied = copyFeedback?.dialog === dialog && copyFeedback.copied
  const copyError = copyFeedback?.dialog === dialog ? copyFeedback.error : ''

  const copyPin = async () => {
    try {
      await copyTextToClipboard(String(dialog.pin ?? ''))
      setCopyFeedback({ dialog, copied: true, error: '' })
    } catch (error) {
      reportError('Could not copy access code', error)
      setCopyFeedback({ dialog, copied: false, error: 'Could not copy automatically. Select and copy the code above.' })
    }
  }

  return createPortal(
    <div className="action-dialog-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget && !saving) onClose()
    }}>
      <section className={`action-dialog ${dialog.variant || ''}`} role="alertdialog" aria-modal="true" aria-labelledby="action-dialog-title" aria-describedby="action-dialog-description">
        <button className="action-dialog-close" type="button" onClick={onClose} disabled={saving} aria-label="Close dialog"><X size={20} /></button>
        <div className={`action-dialog-icon ${isPin ? 'success' : dialog.variant || ''}`}>{isPin ? <Check size={26} /> : <AlertTriangle size={25} />}</div>
        <p className="action-dialog-eyebrow">{dialog.eyebrow || (isPin ? 'Access code ready' : 'Please confirm')}</p>
        <h2 id="action-dialog-title">{dialog.title}</h2>
        <p id="action-dialog-description">{dialog.description}</p>
        {isPin && <div className="generated-pin" aria-label="New access code">{dialog.pin}</div>}
        {copyError && <p className="action-dialog-copy-error" role="status">{copyError}</p>}
        {confirmError?.dialog === dialog && <p className="action-dialog-error" role="alert">{confirmError.message}</p>}
        <div className="action-dialog-actions">
          {isPin
            ? <button ref={confirmRef} className="primary-button" type="button" onClick={copyPin}><Copy size={17} />{copied ? 'Copied' : 'Copy access code'}</button>
            : <button ref={confirmRef} className={dialog.variant === 'danger' ? 'danger-button' : `primary-button ${dialog.variant === 'warning' ? 'warning-action' : dialog.variant === 'success' ? 'success-action' : ''}`} type="button" disabled={saving} onClick={async () => {
              setConfirmError(null)
              const result = await dialog.onConfirm()
              if (result && typeof result === 'object' && typeof result.error === 'string') {
                setConfirmError({ dialog, message: result.error })
                return
              }
              if (result === false) {
                setConfirmError({ dialog, message: 'The action could not be completed. Please try again.' })
                return
              }
              if (result !== 'keep-open') onClose()
            }}>{saving ? 'Please wait…' : dialog.confirmLabel || 'Confirm'}</button>}
          <button className="secondary-button" type="button" onClick={onClose} disabled={saving}>{isPin ? 'OK' : 'Cancel'}</button>
        </div>
      </section>
    </div>,
    document.body,
  )
}

function sanitizeQuestion(value) {
  return Array.from(value.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ''))
    .slice(0, 280)
    .join('')
}

function formatDateTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}, ${date.toLocaleTimeString()}`
}

function collectDeviceInfo() {
  const platform = navigator.userAgentData?.platform || navigator.platform || ''
  return {
    userAgent: navigator.userAgent.slice(0, 512),
    platform: platform.slice(0, 128),
    language: navigator.language.slice(0, 32),
  }
}

function Brand() {
  return <div className="brand"><img className="brand-mark" src="/micme-logo.svg" alt="" /><span className="brand-name">MicMe</span></div>
}

function Nav({ view, navigate, session, logout }) {
  const links = session?.role === 'admin'
    ? [['ask', 'Ask a question'], ['admin', 'Questions'], ['team', 'Team management'], ['qr', 'QR Studio']]
    : session?.role === 'moderator' || session?.role === 'viewer'
      ? session.role === 'viewer'
        ? [['viewer', 'View questions']]
        : [['ask', 'Ask a question'], ['mod', 'Moderator']]
      : []
  return <nav className="topbar">
    <Brand />
    <div className="nav-actions">
      <div className={`nav-links ${links.length === 2 ? 'compact' : ''}`}>
        {links.map(([key, label]) => <button key={key} className={view === key ? 'nav-link active' : 'nav-link'} onClick={() => navigate(key)}>{label}</button>)}
      </div>
      {session && <div className="nav-identity"><strong>{session.name}</strong><span>{session.role}</span></div>}
      {session && <button className="icon-button" aria-label="Sign out" onClick={logout}><LogOut size={18} /></button>}
    </div>
  </nav>
}

function QrStudio() {
  const [value, setValue] = useState('')
  const [qrImage, setQrImage] = useState('')
  const [status, setStatus] = useState('')
  const [statusType, setStatusType] = useState('info')
  const [generating, setGenerating] = useState(false)

  const generate = async event => {
    event.preventDefault()
    const content = value.trim()
    if (!content || generating) return
    setGenerating(true)
    setStatus('')
    try {
      const image = await QRCode.toDataURL(content, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 1024,
        color: { dark: '#211C3A', light: '#FFFFFF' },
      })
      setQrImage(image)
    } catch (error) {
      setQrImage('')
      setStatusType('error')
      setStatus(error.message?.includes('too big')
        ? 'This content is too long for a QR code. Shorten it and try again.'
        : 'Could not generate a QR code from this content. Please try again.')
    } finally {
      setGenerating(false)
    }
  }

  const download = () => {
    if (!qrImage) return
    const link = document.createElement('a')
    link.href = qrImage
    link.download = `micme-qr-${new Date().toISOString().slice(0, 10)}.png`
    document.body.append(link)
    link.click()
    link.remove()
  }

  const share = async () => {
    if (!qrImage) return
    try {
      const response = await fetch(qrImage)
      const imageFile = new File([await response.blob()], 'micme-qr.png', { type: 'image/png' })
      if (!navigator.share || !navigator.canShare?.({ files: [imageFile] })) {
        setStatusType('warning')
        setStatus('This browser cannot share QR images directly. Download the PNG and share it from your device.')
        return
      }
      await navigator.share({ title: 'MicMe QR code', files: [imageFile] })
      setStatusType('success')
      setStatus('QR code shared.')
    } catch (error) {
      if (error.name === 'AbortError') return
      setStatusType('error')
      setStatus('Could not share the QR code. You can download it instead.')
    }
  }

  const clear = () => {
    setValue('')
    setQrImage('')
    setStatus('')
  }

  return <main className="dashboard qr-dashboard">
    <header className="dashboard-head">
      <div><p className="eyebrow"><QrCode size={15} /> Admin tools</p><h1>QR Studio</h1><p className="qr-intro">Turn a link, message, or any text into a shareable QR code.</p></div>
    </header>
    <div className="qr-layout">
      <section className="qr-editor">
        <form onSubmit={generate}>
          <label htmlFor="qr-content">What should this QR code contain?</label>
          <textarea id="qr-content" className="qr-input" value={value} maxLength={2500} disabled={generating} onChange={event => {
            setValue(event.target.value)
            setQrImage('')
            setStatus('')
          }} placeholder="Paste a URL or type any text..." />
          <div className="qr-form-footer">
            <span>{value.length}/2500 characters</span>
            <div>
              <button type="button" className="secondary-button" onClick={clear} disabled={!value && !qrImage}>Clear</button>
              <button className="primary-button" disabled={!value.trim() || generating}>
                <QrCode size={17} /> {generating ? 'Generating...' : 'Generate QR code'}
              </button>
            </div>
          </div>
        </form>
        <div className="qr-privacy"><ShieldCheck size={18} /><p><strong>Private by design</strong><span>Your content is processed in this browser only. MicMe does not upload or save it.</span></p></div>
        {status && <div className={`notice ${statusType}`} role="status">{status}</div>}
      </section>
      <section className={`qr-preview ${qrImage ? 'has-qr' : ''}`} aria-live="polite">
        {qrImage ? <>
          <div className="qr-preview-image"><img src={qrImage} alt="QR code for the entered content" /></div>
          <h2>Your QR code is ready</h2>
          <p>Scan it with a phone camera to open the encoded content.</p>
          <div className="qr-actions">
            <button className="primary-button" onClick={download}><Download size={17} /> Download PNG</button>
            <button className="secondary-button" onClick={share}><Share2 size={17} /> Share QR</button>
          </div>
        </> : <>
          <div className="qr-empty-icon"><QrCode size={46} /></div>
          <h2>Your QR code will appear here</h2>
          <p>Enter your content, then select <strong>Generate QR code</strong>.</p>
        </>}
      </section>
    </div>
  </main>
}

function SubmissionDialog({ result, onClose }) {
  const closeButtonRef = useRef(null)

  useEffect(() => {
    if (!result) return
    closeButtonRef.current?.focus()
    const handleKeyDown = event => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [result, onClose])

  if (!result) return null
  const succeeded = result.type === 'success'
  const closed = result.type === 'closed'

  return createPortal(
    <div className="submission-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section
        className={`submission-dialog ${succeeded ? 'success' : 'error'}`}
        role={succeeded ? 'dialog' : 'alertdialog'}
        aria-modal="true"
        aria-labelledby="submission-title"
        aria-describedby="submission-description"
      >
        <button ref={closeButtonRef} className="submission-close" onClick={onClose} aria-label="Close message"><X size={19} /></button>
        <div className="submission-icon">{succeeded ? <Check size={30} /> : <AlertTriangle size={28} />}</div>
        <p className="submission-eyebrow">{succeeded ? 'Question submitted' : closed ? 'Submissions closed' : 'Submission interrupted'}</p>
        <h2 id="submission-title">{succeeded ? 'You’re all set.' : closed ? 'Not accepting questions' : 'Your draft is safe.'}</h2>
        <p id="submission-description">{succeeded
          ? 'Your question is now live. A moderator will answer it shortly.'
          : closed
            ? 'Sorry, we are no longer accepting questions for now.'
            : 'We couldn’t confirm that your question was sent. Your text is still in the box—check your connection and try again.'}</p>
        <button className="primary-button submission-confirm" onClick={onClose}>{succeeded || closed ? 'OK' : 'Back to my question'}</button>
      </section>
    </div>,
    document.body,
  )
}

function AskPage() {
  const [text, setText] = useState('')
  const [state, setState] = useState('idle')
  const [submissionResult, setSubmissionResult] = useState(null)
  const submit = async (event) => {
    event.preventDefault()
    const submittedText = sanitizeQuestion(text).trim()
    if (!submittedText || state === 'loading') return
    setState('loading')
    try {
      const { acceptingQuestions } = await apiCall('getQuestionSubmissionStatus')
      if (!acceptingQuestions) {
        setState('idle')
        setSubmissionResult({ type: 'closed' })
        return
      }
      const { error } = await supabase.from('questions').insert({
        text: submittedText,
        device_info: collectDeviceInfo(),
      })
      if (error) throw error
      setText(current => current.trim() === submittedText ? '' : current)
      setState('success')
      setSubmissionResult({ type: 'success' })
    } catch (error) {
      reportError('Could not submit question', error)
      try {
        const { acceptingQuestions } = await apiCall('getQuestionSubmissionStatus')
        if (!acceptingQuestions) {
          setState('idle')
          setSubmissionResult({ type: 'closed' })
          return
        }
      } catch (statusError) {
        reportError('Could not verify question submission status', statusError)
      }
      setState('error')
      setSubmissionResult({ type: 'error' })
    }
  }
  return <main className="ask-page">
    <div className="orb orb-one" /><div className="orb orb-two" />
    <section className="ask-copy">
      <div className="eyebrow"><Sparkles size={15} /> Live Q&amp;A</div>
      <h1>What’s on your <em>mind?</em></h1>
      <p>Ask anonymously. Your question will appear instantly for the team to answer.</p>
    </section>
    <section className="question-card">
      <div className="card-label">Your question</div>
      <form onSubmit={submit}>
        <textarea value={text} maxLength={280} disabled={state === 'loading'} onChange={(e) => { setText(sanitizeQuestion(e.target.value)); setState('idle') }} placeholder="Ask anything..." aria-label="Question" autoFocus />
        <div className="composer-footer"><span className={text.length > 250 ? 'count danger' : 'count'}>{text.length}/280</span>
          <button className="primary-button" disabled={state === 'loading' || !text.trim()}>{state === 'loading' ? 'Sending...' : 'Send question'} <ChevronRight size={18} /></button>
        </div>
      </form>
    </section>
    <div className="realtime-pill"><span /> Questions appear in real time</div>
    <SubmissionDialog result={submissionResult} onClose={() => setSubmissionResult(null)} />
  </main>
}

function PinLogin({ onLogin }) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const submit = async (event) => {
    event.preventDefault()
    setLoading(true); setError('')
    try {
      const result = await apiCall('login', { pin, deviceInfo: collectDeviceInfo() })
      if (!['admin', 'moderator', 'viewer'].includes(result.role)) throw new Error('Invalid portal role.')
      onLogin({ role: result.role, name: result.name })
    } catch (error) {
      reportError('Sign-in failed', error)
      setError('We couldn’t sign you in. Check your Access Code and try again.')
    }
    finally { setLoading(false) }
  }
  return <main className="auth-page"><form className="auth-card" onSubmit={submit}>
    <div className="auth-icon"><ShieldCheck /></div>
    <p className="eyebrow centered">Secure access</p>
    <h2>Enter the portal</h2>
    <label htmlFor="portal-access-code">Access code</label>
    <input id="portal-access-code" className="pin-input" type="password" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} placeholder="••••••" value={pin}
      onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} />
    {error && <div className="notice error">{error}</div>}
    <button className="primary-button full" disabled={pin.length !== 6 || loading}>{loading ? 'Verifying...' : 'Enter portal'}</button>
  </form></main>
}

function QuestionList({ role }) {
  const [questions, setQuestions] = useState([])
  const [tab, setTab] = useState('unanswered')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState('')
  const [actionMessage, setActionMessage] = useState('')
  const [actionMessageType, setActionMessageType] = useState('info')
  const [acceptingQuestions, setAcceptingQuestions] = useState(null)
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [openQuestionId, setOpenQuestionId] = useState(null)
  const [dialog, setDialog] = useState(null)
  const closeButtonRef = useRef(null)
  const modalRef = useRef(null)
  const questionTextRef = useRef(null)
  const questionTextContainerRef = useRef(null)
  const isAdmin = role === 'admin'
  const isViewer = role === 'viewer'
  const pageSize = 1000
  const liveUpdatesWarning = 'Live updates are temporarily unavailable, please refresh and try again.'
  const loadQuestions = async () => {
    const allQuestions = []
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase.from('questions').select('*')
        .order('created_at', { ascending: false }).range(from, from + pageSize - 1)
      if (error) throw error
      allQuestions.push(...(data || []))
      if (!data || data.length < pageSize) break
    }
    return allQuestions
  }
  useEffect(() => {
    let active = true
    loadQuestions().then(data => {
      if (active) setQuestions(data)
    }).catch(error => {
      if (active) {
        setActionMessageType('error')
        reportError('Could not load questions', error)
        setActionMessage('Questions could not be loaded. Please try again.')
      }
    })
    let channel
    let retryTimer
    let retryCount = 0
    let retryScheduled = false
    const connect = () => {
      retryScheduled = false
      const currentChannel = supabase.channel(`qroom-questions-${role}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'questions' }, payload => {
          if (payload.eventType === 'DELETE') {
            setSelectedIds(selected => {
              const next = new Set(selected)
              next.delete(payload.old.id)
              return next
            })
            setQuestions(current => current.filter(question => question.id !== payload.old.id))
            return
          }
          setQuestions(current => {
            const updated = payload.new
            return [updated, ...current.filter(question => question.id !== updated.id)]
              .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          })
      })
      channel = currentChannel
      currentChannel.subscribe(status => {
        if (!active || channel !== currentChannel) return
        if (status === 'SUBSCRIBED') {
          retryCount = 0
          retryScheduled = false
          window.clearTimeout(retryTimer)
          setActionMessage(current => current === liveUpdatesWarning ? '' : current)
          return
        }
        if (!['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status) || retryScheduled) return
        if (retryCount >= 5) {
          setActionMessageType('warning')
          setActionMessage(liveUpdatesWarning)
          return
        }
        retryScheduled = true
        retryCount += 1
        retryTimer = window.setTimeout(async () => {
          retryTimer = null
          try {
            await supabase.removeChannel(currentChannel)
            if (active && channel === currentChannel) connect()
          } catch (error) {
            if (!active) return
            reportError('Could not reconnect live question updates', error)
            setActionMessageType('warning')
            setActionMessage(liveUpdatesWarning)
          }
        }, Math.min(1000 * (2 ** (retryCount - 1)), 8000))
      })
    }
    connect()
    return () => {
      active = false
      window.clearTimeout(retryTimer)
      if (channel) supabase.removeChannel(channel)
    }
  }, [role])
  useEffect(() => {
    if (!isAdmin) return undefined
    let active = true
    apiCall('getQuestionSubmissionStatus')
      .then(result => { if (active) setAcceptingQuestions(result.acceptingQuestions) })
      .catch(error => {
        if (!active) return
        reportError('Could not load question submission status', error)
        setActionMessageType('error')
        setActionMessage('Question submission status could not be loaded.')
      })
    return () => { active = false }
  }, [isAdmin])
  const openQuestion = questions.find(question => question.id === openQuestionId) || null
  useLayoutEffect(() => {
    if (!openQuestion || !modalRef.current || !questionTextRef.current || !questionTextContainerRef.current) return undefined

    const fitQuestionText = () => {
      const title = questionTextRef.current
      const container = questionTextContainerRef.current
      if (!title || !container) return

      title.style.fontSize = ''
      const maxSize = Number.parseFloat(window.getComputedStyle(title).fontSize)
      const availableHeight = container.clientHeight
      if (!availableHeight || !maxSize) return

      let low = 14
      let high = maxSize
      title.style.fontSize = `${low}px`
      if (title.scrollHeight > availableHeight) return

      for (let attempt = 0; attempt < 12; attempt += 1) {
        const size = (low + high) / 2
        title.style.fontSize = `${size}px`
        if (title.scrollHeight <= availableHeight && title.scrollWidth <= container.clientWidth) low = size
        else high = size
      }
      title.style.fontSize = `${low}px`
    }

    fitQuestionText()
    const observer = new ResizeObserver(fitQuestionText)
    observer.observe(modalRef.current)
    observer.observe(questionTextContainerRef.current)
    window.addEventListener('resize', fitQuestionText)
    document.fonts?.ready.then(fitQuestionText)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', fitQuestionText)
    }
  }, [openQuestion])

  useEffect(() => {
    if (!openQuestion) return undefined
    const previousOverflow = document.body.style.overflow
    const previousFocus = document.activeElement
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()
    const closeOnEscape = event => {
      if (event.key === 'Escape') setOpenQuestionId(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
      previousFocus?.focus?.()
    }
  }, [openQuestion])
  const visible = useMemo(() => questions
    .filter(question => question.status === tab && question.text?.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => new Date(tab === 'answered' ? b.answered_at || b.created_at : b.created_at)
      - new Date(tab === 'answered' ? a.answered_at || a.created_at : a.created_at)), [questions, tab, search])
  const selectedQuestions = questions.filter(question => selectedIds.has(question.id))
  const deviceInfo = openQuestion?.device_info && typeof openQuestion.device_info === 'object' && !Array.isArray(openQuestion.device_info)
    ? openQuestion.device_info
    : {}
  const hasDeviceInfo = Boolean(deviceInfo.userAgent || deviceInfo.platform || deviceInfo.language)
  const toggleQuestionSelection = (questionId, checked) => {
    setSelectedIds(current => {
      const next = new Set(current)
      if (checked) next.add(questionId)
      else next.delete(questionId)
      return next
    })
  }
  const toggleVisibleSelection = () => {
    const allVisibleSelected = visible.length > 0 && visible.every(question => selectedIds.has(question.id))
    setSelectedIds(current => {
      const next = new Set(current)
      visible.forEach(question => allVisibleSelected ? next.delete(question.id) : next.add(question.id))
      return next
    })
  }
  const exportExcel = rows => {
    const xmlEscape = value => Array.from(String(value ?? '')).filter(character => {
      const codePoint = character.codePointAt(0)
      return codePoint === 9 || codePoint === 10 || codePoint === 13
        || (codePoint >= 0x20 && codePoint <= 0xD7FF)
        || (codePoint >= 0xE000 && codePoint <= 0xFFFD)
        || (codePoint >= 0x10000 && codePoint <= 0x10FFFF)
    }).join('')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    const columns = ['Question', 'Status', 'Submitted at', 'Answered by', 'Answered at']
    const dataRows = rows.map(question => [
      question.text,
      question.status,
      formatDateTime(question.created_at),
      question.answered_by_name || '',
      formatDateTime(question.answered_at),
    ])
    const rowXml = [columns, ...dataRows].map(row => `<Row>${row.map(cell =>
      `<Cell><Data ss:Type="String">${xmlEscape(cell)}</Data></Cell>`,
    ).join('')}</Row>`).join('')
    const workbook = `<?xml version="1.0"?>
      <?mso-application progid="Excel.Sheet"?>
      <Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
        xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
        <Worksheet ss:Name="Questions"><Table>${rowXml}</Table></Worksheet>
      </Workbook>`
    const blob = new Blob([workbook], { type: 'application/vnd.ms-excel;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `qroom-questions-${new Date().toISOString().slice(0, 10)}.xls`
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setActionMessageType('success')
    setActionMessage(`Exported ${rows.length} question${rows.length === 1 ? '' : 's'} to Excel.`)
  }
  const deleteAllQuestions = async () => {
    setBusy('all')
    setActionMessageType('info')
    setActionMessage('Deleting all questions...')
    try {
      const result = await apiCall('deleteAllQuestions')
      setQuestions([])
      setSelectedIds(new Set())
      setOpenQuestionId(null)
      setActionMessageType('success')
      setActionMessage(`Deleted ${result.deleted ?? 0} question${result.deleted === 1 ? '' : 's'}.`)
      return true
    } catch (error) {
      reportError('Could not delete questions', error)
      setActionMessageType('error')
      const message = error instanceof Error
        ? `Questions could not be deleted: ${error.message}`
        : 'Questions could not be deleted. Please try again.'
      setActionMessage(message)
      return { error: message }
    } finally {
      setBusy('')
    }
  }
  const deleteSelectedQuestions = async () => {
    const questionIds = selectedQuestions.map(question => question.id)
    if (!questionIds.length) return
    setBusy('selected')
    setActionMessageType('info')
    setActionMessage(`Deleting ${questionIds.length} selected questions...`)
    try {
      let deleted = 0
      for (let offset = 0; offset < questionIds.length; offset += 500) {
        const result = await apiCall('deleteSelectedQuestions', { questionIds: questionIds.slice(offset, offset + 500) })
        deleted += result.deleted ?? questionIds.slice(offset, offset + 500).length
      }
      setQuestions(current => current.filter(question => !questionIds.includes(question.id)))
      setSelectedIds(new Set())
      setOpenQuestionId(current => questionIds.includes(current) ? null : current)
      setActionMessageType('success')
      setActionMessage(`Deleted ${deleted} selected question${deleted === 1 ? '' : 's'}.`)
      return true
    } catch (error) {
      reportError('Could not delete selected questions', error)
      setActionMessageType('error')
      setActionMessage('Selected questions could not be deleted. Please try again.')
      return false
    } finally {
      setBusy('')
    }
  }
  const updateQuestion = async (question, status) => {
    setBusy(question.id)
    try {
      await apiCall(status === 'answered' ? 'markQuestionAnswered' : 'reopenQuestion', { questionId: question.id })
      setActionMessageType('success')
      setActionMessage('Question updated.')
    } catch (error) {
      reportError('Could not update question', error)
      setActionMessageType('error')
      setActionMessage('The question could not be updated. Please try again.')
    }
    finally { setBusy('') }
  }
  const updateQuestionSubmissionStatus = async accepting => {
    setBusy('submissions')
    try {
      const result = await apiCall('updateQuestionSubmissionStatus', { acceptingQuestions: accepting })
      setAcceptingQuestions(result.acceptingQuestions)
      setActionMessageType('success')
      setActionMessage(accepting ? 'Question submissions are open.' : 'Question submissions are closed.')
      return true
    } catch (error) {
      reportError('Could not update question submission status', error)
      setActionMessageType('error')
      setActionMessage('Question submission status could not be updated. Please try again.')
      return false
    } finally {
      setBusy('')
    }
  }
  return <main className="dashboard">
    <header className="dashboard-head"><div><p className="eyebrow">{role === 'admin' ? 'Control center' : isViewer ? 'Read-only access' : 'Live queue'}</p><h1>{role === 'admin' ? 'Questions overview' : isViewer ? 'Question viewer' : 'Moderator desk'}</h1></div>
      <div className="search-box"><Search size={18} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search questions..." /></div>
    </header>
    <div className="tabs">
      <button className={tab === 'unanswered' ? 'active' : ''} onClick={() => setTab('unanswered')}>Unanswered <span>{questions.filter(q => q.status === 'unanswered').length}</span></button>
      <button className={tab === 'answered' ? 'active' : ''} onClick={() => setTab('answered')}>Answered <span>{questions.filter(q => q.status === 'answered').length}</span></button>
    </div>
    {isAdmin && <div className="question-tools">
      <div className="selection-tools">
        <button className="secondary-button" disabled={!visible.length} onClick={toggleVisibleSelection}>
          {visible.length && visible.every(question => selectedIds.has(question.id)) ? 'Deselect visible' : 'Select visible'}
        </button>
        <span>{selectedIds.size} selected</span>
      </div>
      <div className="question-tool-actions">
        <button className={`secondary-button submission-toggle-button ${acceptingQuestions === null ? '' : acceptingQuestions ? 'stop' : 'resume'}`} disabled={acceptingQuestions === null || Boolean(busy)} onClick={() => setDialog({
          variant: acceptingQuestions ? 'warning' : 'success',
          title: acceptingQuestions ? 'Stop accepting questions?' : 'Start accepting questions?',
          description: acceptingQuestions
            ? 'Visitors and staff will not be able to submit questions until submissions are reopened.'
            : 'Visitors and staff will be able to submit questions again.',
          confirmLabel: acceptingQuestions ? 'Stop submissions' : 'Start submissions',
          onConfirm: () => updateQuestionSubmissionStatus(!acceptingQuestions),
        })}>{acceptingQuestions === null ? 'Loading submissions…' : acceptingQuestions ? 'Stop submissions' : 'Resume submissions'}</button>
        <button className="secondary-button" disabled={!selectedQuestions.length} onClick={() => exportExcel(selectedQuestions)}><FileSpreadsheet size={16} /> Export selected</button>
        <button className="danger-button" disabled={!selectedQuestions.length || busy === 'selected'} onClick={() => setDialog({
          variant: 'danger',
          title: `Delete ${selectedQuestions.length} selected question${selectedQuestions.length === 1 ? '' : 's'}?`,
          description: 'This permanently removes the selected questions and cannot be undone.',
          confirmLabel: 'Delete selected',
          onConfirm: deleteSelectedQuestions,
        })}><Trash2 size={16} /> {busy === 'selected' ? 'Deleting…' : 'Delete selected'}</button>
        <button className="secondary-button" disabled={!questions.length} onClick={() => exportExcel(questions)}><Download size={16} /> Export all</button>
        <button className="danger-button" disabled={!questions.length || busy === 'all'} onClick={() => setDialog({
          variant: 'danger',
          title: `Delete all ${questions.length} questions?`,
          description: 'This permanently removes every question and cannot be undone.',
          confirmLabel: 'Delete all',
          onConfirm: deleteAllQuestions,
        })}><Trash2 size={16} /> {busy === 'all' ? 'Deleting…' : 'Delete all questions'}</button>
      </div>
    </div>}
    {actionMessage && <div className={`notice ${actionMessageType}`} role="status">{actionMessage}</div>}
    <section className="question-grid">{visible.map((question, index) => <article className={`question-item ${isAdmin ? 'selectable' : ''}`} key={question.id} tabIndex={0} aria-label={`View question: ${question.text}`} onClick={() => setOpenQuestionId(question.id)} onKeyDown={event => {
      if (event.target !== event.currentTarget) return
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        setOpenQuestionId(question.id)
      }
    }} style={{ '--delay': `${Math.min(index * 45, 300)}ms` }}>
      {isAdmin && <input className="question-select" type="checkbox" aria-label={`Select question: ${question.text}`} checked={selectedIds.has(question.id)} onClick={event => event.stopPropagation()} onChange={event => toggleQuestionSelection(question.id, event.target.checked)} />}
      <div className={`status-dot ${question.status}`}><CircleDot size={17} /></div>
      <div className="question-body"><div className="question-meta"><span>{statusText[question.status]}</span><time>{formatDateTime(question.created_at)}</time></div><h3>{question.text}</h3>
        {question.status === 'answered' && <div className="answer-meta"><Check size={15} /> Answered by {question.answered_by_name} · {formatDateTime(question.answered_at)}</div>}
        {role === 'admin' && question.status === 'answered' && <button className="text-button" disabled={busy === question.id} onClick={event => { event.stopPropagation(); updateQuestion(question, 'unanswered') }}>Reopen</button>}
      </div>
      {!isViewer && question.status === 'unanswered' && <button className="answer-button" disabled={busy === question.id} onClick={event => { event.stopPropagation(); updateQuestion(question, 'answered') }}><Check size={17} /> {busy === question.id ? 'Updating...' : 'Answer'}</button>}
    </article>)}
      {!visible.length && <div className="empty-state"><Clock3 /><h3>No {tab} questions</h3><p>{search ? 'Try a different search.' : 'New submissions will appear here instantly.'}</p></div>}
    </section>
    {openQuestion && createPortal(<div className="question-modal-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget) setOpenQuestionId(null)
    }}>
      <section ref={modalRef} className="question-modal" role="dialog" aria-modal="true" aria-labelledby="question-modal-title">
        <div className="question-modal-top">
          <div className={`question-modal-status ${openQuestion.status}`}><CircleDot size={16} /> {statusText[openQuestion.status]}</div>
          <button ref={closeButtonRef} className="question-modal-close" aria-label="Close question" onClick={() => setOpenQuestionId(null)}><X size={22} /></button>
        </div>
        <p className="question-modal-label">Anonymous question</p>
        <div ref={questionTextContainerRef} className="question-modal-copy">
          <h2 ref={questionTextRef} id="question-modal-title">{openQuestion.text}</h2>
        </div>
        <div className="question-modal-meta">
          <span>Submitted {formatDateTime(openQuestion.created_at)}</span>
          {openQuestion.status === 'answered' && <span>Answered by {openQuestion.answered_by_name} · {formatDateTime(openQuestion.answered_at)}</span>}
        </div>
        {isAdmin && <section className="question-device-info" aria-label="Submission device information">
          <h3>Submission device</h3>
          {hasDeviceInfo
            ? <dl>
              {typeof deviceInfo.platform === 'string' && deviceInfo.platform && <div><dt>Platform</dt><dd>{deviceInfo.platform}</dd></div>}
              {typeof deviceInfo.language === 'string' && deviceInfo.language && <div><dt>Language</dt><dd>{deviceInfo.language}</dd></div>}
              {typeof deviceInfo.userAgent === 'string' && deviceInfo.userAgent && <div className="device-info-user-agent"><dt>Browser / device</dt><dd>{deviceInfo.userAgent}</dd></div>}
            </dl>
            : <p>Device information was not recorded for this question.</p>}
        </section>}
        <div className="question-modal-actions">
          {!isViewer && openQuestion.status === 'unanswered' && <button className="answer-button" disabled={busy === openQuestion.id} onClick={() => updateQuestion(openQuestion, 'answered')}><Check size={18} /> {busy === openQuestion.id ? 'Updating…' : 'Mark answered'}</button>}
          {isAdmin && openQuestion.status === 'answered' && <button className="secondary-button" disabled={busy === openQuestion.id} onClick={() => updateQuestion(openQuestion, 'unanswered')}>Reopen question</button>}
        </div>
      </section>
    </div>, document.body)}
    <ActionDialog dialog={dialog} onClose={() => setDialog(null)} saving={Boolean(busy)} />
  </main>
}

function AdminPortal() {
  const [moderators, setModerators] = useState([])
  const [logs, setLogs] = useState([])
  const [hasMoreLogs, setHasMoreLogs] = useState(false)
  const [loadingMoreLogs, setLoadingMoreLogs] = useState(false)
  const [name, setName] = useState('')
  const [newRole, setNewRole] = useState('moderator')
  const [message, setMessage] = useState('')
  const [messageType, setMessageType] = useState('info')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dialog, setDialog] = useState(null)
  const [activeAdminTab, setActiveAdminTab] = useState('users')
  const copyPortalLink = async () => {
    const url = new URL(window.location.href)
    url.pathname = '/portal'
    url.search = ''
    url.hash = ''
    try {
      await navigator.clipboard.writeText(url.toString())
      setMessageType('success')
      setMessage('Portal link copied.')
    } catch {
      reportError('Could not copy portal link', new Error('Clipboard access was denied.'))
      setMessageType('warning')
      setMessage('Could not copy the portal link. Please copy the page address.')
    }
  }
  const refresh = async () => {
    try {
      const result = await apiCall('listAdminData')
      setModerators(result.users || result.moderators || [])
      setLogs((result.logs || []).slice(0, 10))
      setHasMoreLogs(Boolean(result.hasMoreLogs))
    } catch (error) {
      reportError('Could not load admin data', error)
      setMessageType('error')
      setMessage('Team information could not be loaded. Please try again.')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { refresh() }, [])
  const loadMoreLogs = async () => {
    if (loadingMoreLogs || !hasMoreLogs || !logs.length) return
    const cursor = logs[logs.length - 1]
    setLoadingMoreLogs(true)
    try {
      const result = await apiCall('listMoreActivityLogs', {
        beforeCreatedAt: cursor.created_at,
        beforeId: String(cursor.id),
      })
      setLogs(current => {
        const currentIds = new Set(current.map(log => String(log.id)))
        return [...current, ...result.logs.filter(log => !currentIds.has(String(log.id)))]
      })
      setHasMoreLogs(Boolean(result.hasMoreLogs))
    } catch (error) {
      reportError('Could not load more activity logs', error)
      setMessageType('error')
      setMessage('More activity logs could not be loaded. Please try again.')
    } finally {
      setLoadingMoreLogs(false)
    }
  }
  useEffect(() => {
    const channel = supabase.channel('qroom-admin-activity-logs')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity_logs' }, payload => {
        setLogs(current => [payload.new, ...current.filter(log => log.id !== payload.new.id)]
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .map(log => ({ ...log, createdAt: log.created_at })))
      })
      .subscribe(status => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setMessageType('warning')
          setMessage('Live activity updates disconnected. Refresh the page to reconnect.')
        }
      })
    return () => { supabase.removeChannel(channel) }
  }, [])
  const create = async e => {
    e.preventDefault()
    if (saving || !name.trim()) return
    setSaving(true)
    setMessageType('info')
    setMessage(`Creating ${newRole}...`)
    try {
      const result = await apiCall('createUser', { name: name.trim(), role: newRole })
      setName('')
      setMessageType('success')
      setMessage(`${result.name || name.trim()} was created as a ${newRole}.`)
      if (result.pin) setDialog({
        kind: 'pin',
        title: 'Save this access code',
        description: `Give this one-time access code to ${result.name || name.trim()}. Copy it now; it will not be shown again.`,
        pin: result.pin,
      })
      await refresh()
    } catch (error) {
      reportError(`Could not create ${newRole}`, error)
      setMessageType('error')
      setMessage(`The ${newRole} could not be created. Please try again.`)
    } finally { setSaving(false) }
  }
  const toggleAction = async user => {
    setSaving(true)
    setMessageType('info')
    setMessage(`Updating ${user.name}...`)
    try {
      await apiCall('updateModerator', { moderatorId: user.id, active: !user.active })
      setMessageType(user.active ? 'warning' : 'success')
      setMessage(`${user.name} is now ${user.active ? 'inactive' : 'active'}.`)
      await refresh()
      return true
    } catch (error) {
      reportError('Could not update user status', error)
      setMessageType('error')
      setMessage('The user could not be updated. Please try again.')
      return false
    } finally { setSaving(false) }
  }
  const toggle = user => {
    const active = !user.active
    setDialog({
      variant: active ? 'success' : 'warning',
      title: `${active ? 'Activate' : 'Deactivate'} ${user.name}?`,
      description: active
        ? 'This user will be able to sign in with their access code again.'
        : 'This user will lose access to the portal immediately.',
      confirmLabel: active ? 'Activate user' : 'Deactivate user',
      onConfirm: () => toggleAction(user),
    })
  }
  const resetPinAction = async user => {
    setSaving(true)
    setMessageType('info')
    setMessage(`Generating a new access code for ${user.name}...`)
    try {
      const result = await apiCall('updateModerator', { moderatorId: user.id, generatePin: true })
      setMessageType('success')
      setMessage(`A new access code was generated for ${user.name}.`)
      if (result.pin) {
        setDialog({
          kind: 'pin',
          title: 'Your new access code',
          description: `The previous code is no longer valid. Give this new code to ${user.name} and copy it before closing this window.`,
          pin: result.pin,
        })
        return 'keep-open'
      }
      await refresh()
      return true
    } catch (error) {
      reportError('Could not generate a new access code', error)
      setMessageType('error')
      setMessage('A new access code could not be generated. Please try again.')
      return false
    } finally { setSaving(false) }
  }
  const resetPin = user => setDialog({
    title: `Create a new access code for ${user.name}?`,
    description: 'The current access code will stop working as soon as the new one is created.',
    confirmLabel: 'Generate new code',
    onConfirm: () => resetPinAction(user),
  })
  const changeRoleAction = async (user, role) => {
    setSaving(true)
    setMessageType('info')
    setMessage(`Changing ${user.name}'s role...`)
    try {
      await apiCall('updateUserRole', { userId: user.id, role })
      setMessageType('success')
      setMessage(`${user.name}'s role was changed to ${role}. Their existing session has been revoked.`)
      await refresh()
      return true
    } catch (error) {
      reportError('Could not change user role', error)
      setMessageType('error')
      setMessage('The user role could not be changed. Please try again.')
      return false
    } finally { setSaving(false) }
  }
  const changeRole = (user, role) => setDialog({
    title: `Change ${user.name} to ${role}?`,
    description: `Their current portal session will end immediately and they will need their access code to sign in again as a ${role}.`,
    confirmLabel: 'Change role',
    onConfirm: () => changeRoleAction(user, role),
  })
  const deleteUserAction = async user => {
    setSaving(true)
    setMessageType('info')
    setMessage(`Deleting ${user.name}...`)
    try {
      await apiCall('deleteModerator', { moderatorId: user.id })
      setMessageType('success')
      setMessage(`${user.name} was deleted.`)
      await refresh()
      return true
    } catch (error) {
      reportError('Could not delete user', error)
      setMessageType('error')
      setMessage('The user could not be deleted. Please try again.')
      return false
    } finally { setSaving(false) }
  }
  const deleteUser = user => setDialog({
    variant: 'danger',
    title: `Delete ${user.name}?`,
    description: 'This permanently removes the user and ends their access immediately.',
    confirmLabel: 'Delete user',
    onConfirm: () => deleteUserAction(user),
  })
  const toggleAllAction = async active => {
    setSaving(true)
    setMessageType('info')
    setMessage(active ? 'Activating moderators...' : 'Deactivating moderators...')
    try {
      await apiCall('updateAllModerators', { active })
      setMessageType(active ? 'success' : 'warning')
      setMessage(active ? 'All moderators are active.' : 'All moderators are inactive.')
      await refresh()
      return true
    } catch (error) {
      reportError('Could not update moderator statuses', error)
      setMessageType('error')
      setMessage('Moderators could not be updated. Please try again.')
      return false
    } finally { setSaving(false) }
  }
  const toggleAll = active => setDialog({
    variant: active ? 'success' : 'warning',
    title: `${active ? 'Activate' : 'Deactivate'} all moderators?`,
    description: active
      ? 'All moderator accounts will be enabled.'
      : 'All moderator accounts will lose portal access.',
    confirmLabel: active ? 'Activate all' : 'Deactivate all',
    onConfirm: () => toggleAllAction(active),
  })
  return <main className="dashboard admin-dashboard">
    <header className="dashboard-head"><div><p className="eyebrow">Administration</p><h1>Team management</h1></div><div className="header-actions"><button className="secondary-button" onClick={copyPortalLink}><Copy size={16} /> Copy portal link</button><button className="secondary-button" disabled={saving} onClick={() => toggleAll(false)}>Deactivate all</button><button className="secondary-button" disabled={saving} onClick={() => toggleAll(true)}>Activate all</button></div></header>
    {message && <div className={`notice ${messageType}`} role="status">{message}</div>}
    <form className="create-form" onSubmit={create}>
      <input value={name} required maxLength={80} onChange={e => setName(e.target.value.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ''))} placeholder="User name" aria-label="User name" />
      <select value={newRole} onChange={event => setNewRole(event.target.value)} aria-label="New user role">
        <option value="moderator">Moderator</option>
        <option value="viewer">Viewer</option>
      </select>
      <button className="primary-button" disabled={saving || !name.trim()}>{saving ? 'Creating...' : `Create ${newRole}`}</button>
    </form>
    <div className="admin-tabs" role="tablist" aria-label="Team management">
      <button id="admin-users-tab" className={activeAdminTab === 'users' ? 'active' : ''} type="button" role="tab" aria-selected={activeAdminTab === 'users'} aria-controls="admin-users-panel" onClick={() => setActiveAdminTab('users')}>Users</button>
      <button id="admin-activity-tab" className={activeAdminTab === 'activity' ? 'active' : ''} type="button" role="tab" aria-selected={activeAdminTab === 'activity'} aria-controls="admin-activity-panel" onClick={() => setActiveAdminTab('activity')}>Activity logs</button>
    </div>
    {activeAdminTab === 'users'
      ? <section id="admin-users-panel" className="admin-tab-panel" role="tabpanel" aria-labelledby="admin-users-tab">
        <h2>Users</h2>
        {loading ? <p>Loading users...</p> : moderators.map(user => <div className="moderator-row" key={user.id}>
          <div className="moderator-identity"><strong>{user.name}</strong><span className={`moderator-status ${user.active ? 'active' : 'inactive'}`}><span aria-hidden="true" />{user.active ? 'Active' : 'Inactive'}</span><small className={user.hasPin ? 'pin-ready' : 'pin-missing'}>Code {user.hasPin ? 'configured' : 'missing'}</small></div>
          <div className="moderator-actions">
            <span className={`role-badge ${user.role || 'moderator'}`}>{user.role || 'moderator'}</span>
            <select value={user.role || 'moderator'} disabled={saving || user.role === 'admin'} aria-label={`Role for ${user.name}`} onChange={event => changeRole(user, event.target.value)}>
              <option value="moderator">Moderator</option>
              <option value="viewer">Viewer</option>
            </select>
            <button className="pin-button" disabled={saving} onClick={() => resetPin(user)}>New code</button>
            <button disabled={saving} className={user.active ? 'deactivate-button' : 'activate-button'} onClick={() => toggle(user)}>{user.active ? 'Deactivate' : 'Activate'}</button>
            <button className="danger-button delete-moderator-button" disabled={saving || user.role === 'admin'} aria-label={`Delete ${user.name}`} onClick={() => deleteUser(user)}><Trash2 size={15} /> Delete</button>
          </div>
        </div>)}
      </section>
      : <section id="admin-activity-panel" className="admin-tab-panel" role="tabpanel" aria-labelledby="admin-activity-tab">
        <h2>Recent activity</h2>
        {loading ? <p>Loading activity...</p> : logs.map(log => <div className="log-row" key={log.id}><span>{log.action}</span><small>Actor: {log.actor_name || 'Admin'}{log.moderator_name && log.moderator_name !== log.actor_name ? ` · User: ${log.moderator_name}` : ''} · {formatDateTime(log.created_at || log.createdAt)}</small></div>)}
        {!loading && hasMoreLogs && <button className="secondary-button activity-more-button" type="button" disabled={loadingMoreLogs} onClick={loadMoreLogs}>{loadingMoreLogs ? 'Loading…' : 'Load 10 more logs'}</button>}
      </section>}
    <ActionDialog dialog={dialog} onClose={() => setDialog(null)} saving={saving} />
  </main>
}

function App() {
  const getViewFromUrl = () => {
    const params = new URLSearchParams(window.location.search)
    if (window.location.pathname.replace(/\/+$/, '') !== '/portal') return params.has('portal') ? 'portal' : 'ask'
    const page = params.get('view')
    return page === 'team' || page === 'qr' ? page : 'portal'
  }
  const initialView = getViewFromUrl()
  const [view, setView] = useState(initialView)
  const [session, setSession] = useState(null)
  const [globalError, setGlobalError] = useState('')
  const [ready, setReady] = useState(!isSupabaseConfigured)
  const [startupError, setStartupError] = useState(
    isSupabaseConfigured ? '' : 'MicMe is having trouble connecting. Please try again in a moment.',
  )
  useEffect(() => {
    let active = true
    if (!isSupabaseConfigured) {
      reportError('Application configuration is unavailable', new Error('Backend configuration is missing.'))
      return () => { active = false }
    }
    ensureAnonymousSession()
      .then(async () => {
        const result = await apiCall('getSession')
        if (active && ['admin', 'moderator', 'viewer'].includes(result.role)) {
          setSession({ role: result.role, name: result.name })
          const requestedView = new URLSearchParams(window.location.search).get('view')
          setView(result.role === 'admin'
            ? requestedView === 'team' || requestedView === 'qr' ? requestedView : 'admin'
            : result.role === 'viewer' ? 'viewer' : 'mod')
        }
      })
      .catch(error => {
        if (active) {
          reportError('Application initialization failed', error)
          setStartupError('MicMe is having trouble connecting. Please try again in a moment.')
        }
      })
      .finally(() => { if (active) setReady(true) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('portal')) {
      window.history.replaceState(null, '', '/portal')
    }
    const handlePopState = () => {
      setView(getViewFromUrl())
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])
  const navigate = nextView => {
    const path = nextView === 'ask' ? '/' : '/portal'
    const query = nextView === 'team' || nextView === 'qr' ? `?view=${nextView}` : ''
    const nextUrl = `${path}${query}`
    if (nextUrl !== `${window.location.pathname}${window.location.search}`) {
      window.history.pushState(null, '', nextUrl)
    }
    setView(nextView)
  }
  const acceptLogin = user => {
    setSession(user)
    setGlobalError('')
    setView(user.role === 'admin' ? 'admin' : user.role === 'viewer' ? 'viewer' : 'mod')
  }
  useEffect(() => {
    if (!session) return undefined
    let active = true
    const verifySession = async () => {
      try {
        const current = await apiCall('getSession')
        if (!active) return
        if (current.role !== session.role || current.name !== session.name) {
          setSession(null)
          setView('portal')
          setGlobalError('Your access changed. Enter your access code again to continue.')
          await supabase.auth.signOut()
          await ensureAnonymousSession()
        }
      } catch (error) {
        reportError('Could not verify the current portal session', error)
      }
    }
    const interval = window.setInterval(verifySession, 3000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [session])
  const logout = async () => {
    try {
      await apiCall('logout')
    } catch (error) {
      reportError('Could not end the server portal session', error)
    }
    const { error } = await supabase.auth.signOut()
    if (error) {
      reportError('Could not clear the local portal session', error)
      setGlobalError('We couldn’t complete sign-out. Please try again.')
      return
    }
    setSession(null)
    setGlobalError('')
    try {
      await ensureAnonymousSession()
    } catch (sessionError) {
      reportError('Could not restore anonymous access', sessionError)
      setGlobalError('We couldn’t restore a sign-in session. Please refresh and try again.')
    }
    navigate('portal')
  }
  const portalContent = session?.role === 'admin'
    ? view === 'team' ? <AdminPortal /> : view === 'qr' ? <QrStudio /> : view === 'ask' ? <AskPage /> : <QuestionList role="admin" />
    : session?.role === 'moderator' ? view === 'ask' ? <AskPage /> : <QuestionList role="moderator" />
      : session?.role === 'viewer' ? <QuestionList role="viewer" /> : null
  const isPortalPath = window.location.pathname.replace(/\/+$/, '') === '/portal'
    || new URLSearchParams(window.location.search).has('portal')
  const showLogin = isPortalPath && !session
  if (!ready) return <main className="app-loading" role="status" aria-label="Loading MicMe">
    <div className="background-grid" aria-hidden="true" />
    <div className="loading-mark">
      <span className="loading-orbit" aria-hidden="true" />
      <img src="/micme-logo.svg" alt="MicMe" />
    </div>
  </main>
  if (startupError) return <main className="auth-page"><section className="auth-card"><div className="auth-icon"><ShieldCheck /></div><h2>We’re having trouble connecting</h2><p>{startupError}</p></section></main>
  return <div className="app-shell">
    <div className="background-grid" />
    <Nav view={view} navigate={navigate} session={session} logout={logout} />
    {globalError && <div className="notice error global-notice" role="alert">{globalError}</div>}
    {showLogin ? <PinLogin onLogin={acceptLogin} /> : session?.role === 'viewer' ? <QuestionList role="viewer" /> : view === 'ask' ? <AskPage /> : portalContent}
  </div>
}

export default App
