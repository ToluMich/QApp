import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Check, ChevronRight, CircleDot, Clock3, Copy, Download, FileSpreadsheet, LogOut, QrCode, Search, Share2, ShieldCheck, Sparkles, Trash2, Users, X } from 'lucide-react'
import QRCode from 'qrcode'
import { apiCall, ensureAnonymousSession, isSupabaseConfigured, supabase } from './supabase'
import './App.css'
import './theme.css'

const statusText = { unanswered: 'Awaiting answer', answered: 'Answered' }

function reportError(context, error) {
  console.error(`[MicMe] ${context}`, error)
}

function Brand() {
  return <div className="brand"><img className="brand-mark" src="/micme-logo.svg" alt="" /><span className="brand-name">MicMe</span></div>
}

function Nav({ view, navigate, session, logout }) {
  const links = session?.role === 'admin'
    ? [['ask', 'Ask a question'], ['mod', 'Moderator'], ['admin', 'Questions'], ['team', 'Team management'], ['qr', 'QR Studio']]
    : session?.role === 'moderator'
      ? [['ask', 'Ask a question'], ['mod', 'Moderator']]
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
        <p className="submission-eyebrow">{succeeded ? 'Question submitted' : 'Submission interrupted'}</p>
        <h2 id="submission-title">{succeeded ? 'You’re all set.' : 'Your draft is safe.'}</h2>
        <p id="submission-description">{succeeded
          ? 'Your question is now live. A moderator will answer it shortly.'
          : 'We couldn’t confirm that your question was sent. Your text is still in the box—check your connection and try again.'}</p>
        <button className="primary-button submission-confirm" onClick={onClose}>{succeeded ? 'Done' : 'Back to my question'}</button>
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
    const submittedText = text.trim()
    if (!submittedText || state === 'loading') return
    setState('loading')
    try {
      const { error } = await supabase.from('questions').insert({ text: submittedText })
      if (error) throw error
      setText(current => current.trim() === submittedText ? '' : current)
      setState('success')
      setSubmissionResult({ type: 'success' })
    } catch {
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
        <textarea value={text} maxLength={280} disabled={state === 'loading'} onChange={(e) => { setText(e.target.value); setState('idle') }} placeholder="Ask anything..." aria-label="Question" autoFocus />
        <div className="composer-footer"><span className={text.length > 250 ? 'count danger' : 'count'}>{text.length}/280</span>
          <button className="primary-button" disabled={state === 'loading' || !text.trim()}>{state === 'loading' ? 'Sending...' : 'Send question'} <ChevronRight size={18} /></button>
        </div>
      </form>
    </section>
    <div className="realtime-pill"><span /> Questions appear in real time</div>
    <SubmissionDialog result={submissionResult} onClose={() => setSubmissionResult(null)} />
  </main>
}

function PinLogin({ role, onLogin }) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const submit = async (event) => {
    event.preventDefault()
    setLoading(true); setError('')
    try {
      const result = await apiCall(role === 'admin' ? 'loginAdmin' : 'loginModerator', { pin })
      onLogin({ role, name: result.name })
    } catch (error) {
      reportError('Sign-in failed', error)
      setError('We couldn’t sign you in. Check your PIN and try again.')
    }
    finally { setLoading(false) }
  }
  return <main className="auth-page"><form className="auth-card" onSubmit={submit}>
    <div className="auth-icon">{role === 'admin' ? <ShieldCheck /> : <Users />}</div>
    <p className="eyebrow centered">{role === 'admin' ? 'Administration' : 'Moderator access'}</p>
    <h2>{role === 'admin' ? 'Welcome, admin' : 'Enter workspace'}</h2>
    <label htmlFor={`${role}-pin`}>Access code</label>
    <input id={`${role}-pin`} className="pin-input" type="password" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} placeholder="••••••" value={pin}
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
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [openQuestionId, setOpenQuestionId] = useState(null)
  const closeButtonRef = useRef(null)
  const modalRef = useRef(null)
  const questionTextRef = useRef(null)
  const questionTextContainerRef = useRef(null)
  const isAdmin = role === 'admin'
  const pageSize = 1000
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
    const channel = supabase.channel(`qroom-questions-${role}`)
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
      .subscribe(status => {
        if (status === 'CHANNEL_ERROR' && active) {
          setActionMessageType('warning')
          setActionMessage('Live updates are temporarily unavailable. Please refresh to try again.')
        }
      })
    return () => {
      active = false
      supabase.removeChannel(channel)
    }
  }, [role])
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
  const visible = useMemo(() => questions.filter(q => q.status === tab && q.text?.toLowerCase().includes(search.toLowerCase())), [questions, tab, search])
  const selectedQuestions = questions.filter(question => selectedIds.has(question.id))
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
      question.created_at ? new Date(question.created_at).toLocaleString() : '',
      question.answered_by_name || '',
      question.answered_at ? new Date(question.answered_at).toLocaleString() : '',
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
    if (!window.confirm(`Permanently delete all ${questions.length} questions? This cannot be undone.`)) return
    setBusy('all')
    setActionMessageType('info')
    setActionMessage('Deleting all questions...')
    try {
      const result = await apiCall('deleteAllQuestions')
      setQuestions([])
      setSelectedIds(new Set())
      setOpenQuestionId(null)
      try {
        setQuestions(await loadQuestions())
      } catch (error) {
        reportError('Could not refresh questions after deletion', error)
        setActionMessageType('warning')
        setActionMessage(`Deleted ${result.deleted ?? 0} questions, but the list could not be refreshed. Please refresh the page.`)
        return
      }
      setActionMessageType('success')
      setActionMessage(`Deleted ${result.deleted ?? 0} question${result.deleted === 1 ? '' : 's'}.`)
    } catch (error) {
      reportError('Could not delete questions', error)
      setActionMessageType('error')
      setActionMessage('Questions could not be deleted. Please try again.')
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
  const date = value => {
    if (typeof value === 'string') return new Date(value).toLocaleString()
    return ''
  }
  return <main className="dashboard">
    <header className="dashboard-head"><div><p className="eyebrow">{role === 'admin' ? 'Control center' : 'Live queue'}</p><h1>{role === 'admin' ? 'Questions overview' : 'Moderator desk'}</h1></div>
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
        <button className="secondary-button" disabled={!selectedQuestions.length} onClick={() => exportExcel(selectedQuestions)}><FileSpreadsheet size={16} /> Export selected</button>
        <button className="secondary-button" disabled={!questions.length} onClick={() => exportExcel(questions)}><Download size={16} /> Export all</button>
        <button className="danger-button" disabled={!questions.length || busy === 'all'} onClick={deleteAllQuestions}><Trash2 size={16} /> {busy === 'all' ? 'Deleting…' : 'Delete all questions'}</button>
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
      <div className="question-body"><div className="question-meta"><span>{statusText[question.status]}</span><time>{date(question.created_at)}</time></div><h3>{question.text}</h3>
        {question.status === 'answered' && <div className="answer-meta"><Check size={15} /> Answered by {question.answered_by_name} · {date(question.answered_at)}</div>}
        {role === 'admin' && question.status === 'answered' && <button className="text-button" disabled={busy === question.id} onClick={event => { event.stopPropagation(); updateQuestion(question, 'unanswered') }}>Reopen</button>}
      </div>
      {question.status === 'unanswered' && <button className="answer-button" disabled={busy === question.id} onClick={event => { event.stopPropagation(); updateQuestion(question, 'answered') }}><Check size={17} /> {busy === question.id ? 'Updating...' : 'Answer'}</button>}
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
          <span>Submitted {date(openQuestion.created_at)}</span>
          {openQuestion.status === 'answered' && <span>Answered by {openQuestion.answered_by_name} · {date(openQuestion.answered_at)}</span>}
        </div>
        <div className="question-modal-actions">
          {openQuestion.status === 'unanswered' && <button className="answer-button" disabled={busy === openQuestion.id} onClick={() => updateQuestion(openQuestion, 'answered')}><Check size={18} /> {busy === openQuestion.id ? 'Updating…' : 'Mark answered'}</button>}
          {isAdmin && openQuestion.status === 'answered' && <button className="secondary-button" disabled={busy === openQuestion.id} onClick={() => updateQuestion(openQuestion, 'unanswered')}>Reopen question</button>}
        </div>
      </section>
    </div>, document.body)}
  </main>
}

function AdminPortal() {
  const [moderators, setModerators] = useState([])
  const [logs, setLogs] = useState([])
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [messageType, setMessageType] = useState('info')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [linkMessage, setLinkMessage] = useState('')
  const copyModeratorLink = async () => {
    const url = new URL(window.location.href)
    url.searchParams.set('portal', 'moderator')
    url.searchParams.delete('view')
    url.hash = ''
    const link = url.toString()
    try {
      await navigator.clipboard.writeText(link)
      setLinkMessage('Moderator access link copied.')
    } catch {
      setLinkMessage(`Copy this link: ${link}`)
    }
  }
  const refresh = async () => {
    try {
      const result = await apiCall('listAdminData')
      setModerators(result.moderators || [])
      setLogs(result.logs || [])
    } catch (error) {
      reportError('Could not load admin data', error)
      setMessageType('error')
      setMessage('Team information could not be loaded. Please try again.')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { refresh() }, [])
  useEffect(() => {
    const channel = supabase.channel('qroom-admin-activity-logs')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity_logs' }, payload => {
        setLogs(current => [payload.new, ...current.filter(log => log.id !== payload.new.id)]
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .slice(0, 100)
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
    if (saving) return
    setSaving(true)
    setMessageType('info')
    setMessage('Creating moderator...')
    try {
      const result = await apiCall('createModerator', { name })
      setName('')
      setMessageType('success')
      setMessage(result.pin ? `Created ${result.name}. Initial PIN: ${result.pin}` : 'Moderator created.')
      await refresh()
      if (result.pin) setMessage(`Created ${result.name}. Initial PIN: ${result.pin}`)
    } catch (error) { reportError('Could not create moderator', error); setMessageType('error'); setMessage('The moderator could not be created. Please try again.') }
    finally { setSaving(false) }
  }
  const toggle = async moderator => {
    if (moderator.active && !window.confirm(`Deactivate ${moderator.name}?`)) return
    setSaving(true)
    setMessageType('info')
    setMessage(`Updating ${moderator.name}...`)
    try {
      await apiCall('updateModerator', { moderatorId: moderator.id, active: !moderator.active })
      setMessageType(moderator.active ? 'warning' : 'success')
      setMessage(`${moderator.name} is now ${moderator.active ? 'inactive' : 'active'}.`)
      await refresh()
    } catch (error) { reportError('Could not update moderator', error); setMessageType('error'); setMessage('The moderator could not be updated. Please try again.') }
    finally { setSaving(false) }
  }
  const resetPin = async moderator => {
    if (!window.confirm(`Generate a new login PIN for ${moderator.name}? Their current PIN will stop working.`)) return
    setSaving(true)
    setMessageType('info')
    setMessage(`Generating a new PIN for ${moderator.name}...`)
    try {
      const result = await apiCall('updateModerator', { moderatorId: moderator.id, generatePin: true })
      setMessageType('success')
      setMessage(`A new PIN was generated for ${moderator.name}.`)
      if (result.pin) window.prompt(`New PIN for ${moderator.name}`, result.pin)
      await refresh()
    } catch (error) { reportError('Could not generate a new PIN', error); setMessageType('error'); setMessage('A new PIN could not be generated. Please try again.') }
    finally { setSaving(false) }
  }
  const deleteModerator = async moderator => {
    if (!window.confirm(`Permanently delete moderator ${moderator.name}? They will lose access immediately.`)) return
    setSaving(true)
    setMessageType('info')
    setMessage(`Deleting ${moderator.name}...`)
    try {
      await apiCall('deleteModerator', { moderatorId: moderator.id })
      setMessageType('success')
      setMessage(`${moderator.name} was deleted.`)
      await refresh()
    } catch (error) {
      reportError('Could not delete moderator', error)
      setMessageType('error')
      setMessage('The moderator could not be deleted. Please try again.')
    } finally { setSaving(false) }
  }
  const toggleAll = async active => {
    if (!active && !window.confirm('Deactivate all moderators?')) return
    setSaving(true)
    setMessageType('info')
    setMessage(active ? 'Activating moderators...' : 'Deactivating moderators...')
    try {
      await apiCall('updateAllModerators', { active })
      setMessageType(active ? 'success' : 'warning')
      setMessage(active ? 'All moderators are active.' : 'All moderators are inactive.')
      await refresh()
    } catch (error) { reportError('Could not update moderators', error); setMessageType('error'); setMessage('Moderators could not be updated. Please try again.') }
    finally { setSaving(false) }
  }
  return <main className="dashboard admin-dashboard">
    <header className="dashboard-head"><div><p className="eyebrow">Administration</p><h1>Team management</h1></div><div className="header-actions"><button className="secondary-button" onClick={copyModeratorLink}><Copy size={16} /> Copy moderator link</button><button className="secondary-button" disabled={saving} onClick={() => toggleAll(false)}>Deactivate all</button><button className="secondary-button" disabled={saving} onClick={() => toggleAll(true)}>Activate all</button></div></header>
    {linkMessage && <div className="notice" role="status">{linkMessage}</div>}
    <form className="create-form" onSubmit={create}><input value={name} required maxLength={80} onChange={e => setName(e.target.value)} placeholder="Moderator name" /><button className="primary-button" disabled={saving || !name.trim()}>{saving ? 'Creating...' : 'Create moderator'}</button>{message && <span className={`notice compact ${messageType}`} role="status">{message}</span>}</form>
    <div className="admin-columns">
      <section><h2>Moderators</h2>{loading ? <p>Loading moderators...</p> : moderators.map(moderator => <div className="moderator-row" key={moderator.id}><div className="moderator-identity"><strong>{moderator.name}</strong><span className={`moderator-status ${moderator.active ? 'active' : 'inactive'}`}><span aria-hidden="true" />{moderator.active ? 'Active' : 'Inactive'}</span><small className={moderator.hasPin ? 'pin-ready' : 'pin-missing'}>PIN {moderator.hasPin ? 'configured' : 'missing'}</small></div><button className="pin-button" disabled={saving} onClick={() => resetPin(moderator)}>New PIN</button><button disabled={saving} className={moderator.active ? 'deactivate-button' : 'activate-button'} onClick={() => toggle(moderator)}>{moderator.active ? 'Deactivate' : 'Activate'}</button><button className="danger-button delete-moderator-button" disabled={saving} aria-label={`Delete ${moderator.name}`} onClick={() => deleteModerator(moderator)}><Trash2 size={15} /> Delete</button></div>)}</section>
      <section><h2>Activity log</h2>{loading ? <p>Loading activity...</p> : logs.map(log => <div className="log-row" key={log.id}><span>{log.action}</span><small>{log.moderator_name || log.actor_name || 'Admin'} · {log.createdAt}</small></div>)}</section>
    </div>
  </main>
}

function App() {
  const getPortalFromUrl = () => {
    const portals = new URLSearchParams(window.location.search).getAll('portal')
    return portals.length === 1 && (portals[0] === 'admin' || portals[0] === 'moderator')
      ? portals[0]
      : null
  }
  const getViewFromUrl = () => {
    const params = new URLSearchParams(window.location.search)
    const portal = getPortalFromUrl()
    if (portal === 'moderator') return 'mod'
    if (portal === 'admin') {
      const page = params.get('view')
      return page === 'team' || page === 'qr' ? page : 'admin'
    }
    return 'ask'
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
        if (active && result.role) setSession({ role: result.role, name: result.name })
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
    const params = new URLSearchParams(window.location.search)
    if (params.has('portal') && !getPortalFromUrl()) {
      params.delete('portal')
      params.delete('view')
      const query = params.toString()
      window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`)
    }
    const handlePopState = () => {
      setView(getViewFromUrl())
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])
  const navigate = nextView => {
    const params = new URLSearchParams(window.location.search)
    if (nextView === 'ask') {
      params.delete('portal')
      params.delete('view')
    } else if (nextView === 'mod') {
      params.set('portal', 'moderator')
      params.delete('view')
    } else {
      params.set('portal', 'admin')
      if (nextView === 'team' || nextView === 'qr') params.set('view', nextView)
      else params.delete('view')
    }
    const query = params.toString()
    const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}`
    if (nextUrl !== `${window.location.pathname}${window.location.search}`) {
      window.history.pushState(null, '', nextUrl)
    }
    setView(nextView)
  }
  const logout = async () => {
    try {
      await apiCall('logout')
      await supabase.auth.signOut()
      await ensureAnonymousSession()
      setSession(null)
      setGlobalError('')
      navigate('ask')
    } catch (error) {
      reportError('Could not sign out', error)
      setGlobalError('We couldn’t complete that request. Please try again.')
    }
  }
  const portalContent = session?.role === 'admin'
    ? view === 'team' ? <AdminPortal /> : view === 'admin' ? <QuestionList role="admin" /> : view === 'qr' ? <QrStudio /> : null
    : session?.role === 'moderator' && view === 'mod' ? <QuestionList role="moderator" /> : null
  const loginRole = view === 'admin' || view === 'team' || view === 'qr' ? 'admin' : 'moderator'
  const showLogin = (view === 'admin' || view === 'team' || view === 'mod' || view === 'qr') && session?.role !== loginRole
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
    {showLogin ? <PinLogin role={loginRole} onLogin={setSession} /> : view === 'ask' ? <AskPage /> : portalContent}
  </div>
}

export default App
