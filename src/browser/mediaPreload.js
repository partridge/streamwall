import { ipcRenderer, webFrame } from 'electron'

const VIDEO_OVERRIDE_STYLE = `
  * {
    pointer-events: none;
    display: none !important;
    position: static !important;
    z-index: 0 !important;
  }
  html, body, video, audio {
    display: block !important;
    background: black !important;
  }
  html, body {
    overflow: hidden !important;
    background: black !important;
  }
  video, iframe.__video__, audio {
    display: block !important;
    position: fixed !important;
    left: 0 !important;
    right: 0 !important;
    top: 0 !important;
    bottom: 0 !important;
    width: 100vw !important;
    height: 100vh !important;
    object-fit: cover !important;
    transition: none !important;
    z-index: 999999 !important;
  }
  audio {
    z-index: 999998 !important;
  }
  .__video_parent__ {
    display: block !important;
  }
  video.__rot180__ {
    transform: rotate(180deg) !important;
  }
  /* For 90 degree rotations, we position the video with swapped width and height and rotate it into place.
     It's helpful to offset the video so the transformation is centered in the viewport center.
     We move the video top left corner to center of the page and then translate half the video dimensions up and left.
     Note that the width and height are swapped in the translate because the video starts with the side dimensions swapped. */
  video.__rot90__ {
    transform: translate(-50vh, -50vw) rotate(90deg) !important;
  }
  video.__rot270__ {
    transform: translate(-50vh, -50vw) rotate(270deg) !important;
  }
  video.__rot90__, video.__rot270__ {
    left: 50vw !important;
    top: 50vh !important;
    width: 100vh !important;
    height: 100vw !important;
  }
`
const NO_SCROLL_STYLE = `
  html, body {
    overflow: hidden !important;
  }
`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function lockdownMediaTags() {
  webFrame.executeJavaScript(`
    for (const el of document.querySelectorAll('video, audio')) {
      if (el.__sw) {
        continue
      }
      el.muted = true
      // Prevent sites from unmuting (Periscope, I'm looking at you!)
      Object.defineProperty(el, 'muted', { writable: true, value: false })
      // Prevent Facebook from pausing the video after page load.
      Object.defineProperty(el, 'pause', { writable: false, value: () => {} })
      el.__sw = true
    }
  `)
}

// Watch for media tags and mute them as soon as possible.
function watchMediaTags(kind, onFirstOfKind) {
  let foundMatch = false
  const observer = new MutationObserver((mutationList) => {
    if (kind) {
      const el = document.querySelector(kind)
      if (el && !foundMatch) {
        onFirstOfKind(el)
        foundMatch = true
      }
    }
    lockdownMediaTags()
  })
  document.addEventListener('DOMContentLoaded', () => {
    observer.observe(document.body, { subtree: true, childList: true })
  })
}

async function waitForVideo(kind) {
  const waitForTag = new Promise((resolve) => watchMediaTags(kind, resolve))
  let video = await Promise.race([waitForTag, sleep(10000)])
  if (video) {
    return { video }
  }

  let tries = 0
  let iframe
  while ((!video || !video.src) && tries < 10) {
    for (iframe of document.querySelectorAll('iframe')) {
      if (!iframe.contentDocument) {
        continue
      }
      video = iframe.contentDocument.querySelector(kind)
      if (video) {
        break
      }
    }
    tries++
    await sleep(200)
  }
  if (video) {
    return { video, iframe }
  }
  return {}
}

const periscopeHacks = {
  isMatch() {
    return (
      location.host === 'www.pscp.tv' || location.host === 'www.periscope.tv'
    )
  },
  onLoad() {
    const playButton = document.querySelector('.PlayButton')
    if (playButton) {
      playButton.click()
    }
  },
  afterPlay(video) {
    const baseVideoEl = document.querySelector('div.BaseVideo')
    if (!baseVideoEl) {
      return
    }

    function positionPeriscopeVideo() {
      // Periscope videos can be rotated using transform matrix. They need to be rotated correctly.
      const tr = baseVideoEl.style.transform
      if (tr.endsWith('matrix(0, 1, -1, 0, 0, 0)')) {
        video.className = '__rot90__'
      } else if (tr.endsWith('matrix(-1, 0, 0, -1, 0)')) {
        video.className = '__rot180__'
      } else if (tr.endsWith('matrix(0, -1, 1, 0, 0, 0)')) {
        video.className = '__rot270__'
      }
    }

    positionPeriscopeVideo()
    const obs = new MutationObserver((ml) => {
      for (const m of ml) {
        if (m.attributeName === 'style') {
          positionPeriscopeVideo()
          return
        }
      }
    })
    obs.observe(baseVideoEl, { attributes: true })
  },
}

async function findVideo(kind) {
  if (periscopeHacks.isMatch()) {
    periscopeHacks.onLoad()
  }

  const { video, iframe } = await waitForVideo(kind)
  if (!video) {
    throw new Error('could not find video')
  }
  if (iframe) {
    // TODO: verify iframe still works
    const style = iframe.contentDocument.createElement('style')
    style.innerHTML = VIDEO_OVERRIDE_STYLE
    iframe.contentDocument.head.appendChild(style)
    iframe.className = '__video__'
    let parentEl = iframe.parentElement
    while (parentEl) {
      parentEl.className = '__video_parent__'
      parentEl = parentEl.parentElement
    }
    iframe.contentDocument.body.appendChild(video)
  } else {
    document.body.appendChild(video)
  }

  const videoReady = new Promise((resolve) =>
    video.addEventListener('canplay', resolve, { once: true }),
  )

  video.play()

  if (periscopeHacks.isMatch()) {
    periscopeHacks.afterPlay(video)
  }

  if (!video.videoWidth) {
    await videoReady
  }

  const info = {
    title: document.title,
    intrinsicWidth: video.videoWidth,
    intrinsicHeight: video.videoHeight,
  }
  return { info, video }
}

async function main(viewId) {
  const viewInit = ipcRenderer.invoke('view-init', { viewId })
  const pageReady = new Promise((resolve) => process.once('loaded', resolve))

  const [{ content }] = await Promise.all([viewInit, pageReady])

  if (content.kind === 'video' || content.kind === 'audio') {
    webFrame.insertCSS(VIDEO_OVERRIDE_STYLE)
  } else if (content.kind === 'web') {
    webFrame.insertCSS(NO_SCROLL_STYLE)
  }

  const { info, video } = await findVideo(content.kind)
  ipcRenderer.send('view-loaded', { viewId, info })

  ipcRenderer.on('mute', () => {
    video.muted = true
  })
  ipcRenderer.on('unmute', () => {
    video.muted = false
  })
}

if (window.name) {
  try {
    main(window.name)
  } catch (err) {
    ipcRenderer.send('view-error', { viewId, err })
  }
} else {
  watchMediaTags()
}
