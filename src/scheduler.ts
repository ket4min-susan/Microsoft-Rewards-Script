import { fork, ChildProcess } from 'node:child_process'
import path from 'node:path'

interface ScheduleCalculation {
    nextDate: Date
    delayMs: number
    formatted: string
    jitterMinutes: number
}

const TARGET_HOUR = parseInt(process.env.SCHEDULE_HOUR ?? '9', 10)
const TARGET_MINUTE = parseInt(process.env.SCHEDULE_MINUTE ?? '0', 10)
const TIMEZONE = process.env.TZ ?? process.env.SCHEDULE_TIMEZONE ?? 'Asia/Ho_Chi_Minh'
const JITTER_MAX_MINUTES = parseInt(process.env.SCHEDULE_JITTER_MINUTES ?? '15', 10)
const RUN_ON_START = process.env.RUN_ON_START !== 'false'

let activeChild: ChildProcess | null = null
let isShuttingDown = false
let isJobRunning = false
let nextRunTimestamp = 0
let lastHeartbeatHour = -1

function log(module: string, message: string): void {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19)
    console.log(`[${timestamp}] [${module}] ${message}`)
}

function computeNextRun(
    timeZone: string,
    targetHour: number,
    targetMinute: number,
    maxJitterMin: number
): ScheduleCalculation {
    const now = new Date()
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    })

    const parts = formatter.formatToParts(now)
    const p: Record<string, number> = {}
    for (const part of parts) {
        if (part.type !== 'literal') p[part.type] = parseInt(part.value, 10)
    }

    const pad = (n: number) => String(n).padStart(2, '0')
    let targetYear = p['year'] ?? now.getFullYear()
    let targetMonth = p['month'] ?? now.getMonth() + 1
    let targetDay = p['day'] ?? now.getDate()

    const currentZonedHour = (p['hour'] ?? 0) % 24
    const currentZonedMin = p['minute'] ?? 0

    if (currentZonedHour > targetHour || (currentZonedHour === targetHour && currentZonedMin >= targetMinute)) {
        const tomorrow = new Date(Date.UTC(targetYear, targetMonth - 1, targetDay + 1))
        targetYear = tomorrow.getUTCFullYear()
        targetMonth = tomorrow.getUTCMonth() + 1
        targetDay = tomorrow.getUTCDate()
    }

    const isoString = `${targetYear}-${pad(targetMonth)}-${pad(targetDay)}T${pad(targetHour)}:${pad(targetMinute)}:00`
    const tentativeUtc = new Date(`${isoString}Z`)
    const tentativeParts = formatter.formatToParts(tentativeUtc)
    const tp: Record<string, number> = {}
    for (const part of tentativeParts) {
        if (part.type !== 'literal') tp[part.type] = parseInt(part.value, 10)
    }

    const zonedMinutes = ((tp['hour'] ?? 0) % 24) * 60 + (tp['minute'] ?? 0)
    const utcMinutes = tentativeUtc.getUTCHours() * 60 + tentativeUtc.getUTCMinutes()
    let offsetMinutes = zonedMinutes - utcMinutes
    if ((tp['day'] ?? 0) > tentativeUtc.getUTCDate()) offsetMinutes += 24 * 60
    if ((tp['day'] ?? 0) < tentativeUtc.getUTCDate()) offsetMinutes -= 24 * 60

    // Generate random jitter between 1 and JITTER_MAX_MINUTES to avoid robotic identical execution times
    const jitterSec = maxJitterMin > 0 ? Math.floor(Math.random() * (maxJitterMin * 60 - 30)) + 30 : 0
    const jitterMs = jitterSec * 1000
    const jitterMinutes = parseFloat((jitterSec / 60).toFixed(2))

    const targetUtcTimestamp = tentativeUtc.getTime() - offsetMinutes * 60 * 1000 + jitterMs
    const nextDate = new Date(targetUtcTimestamp)
    const delayMs = Math.max(1000, targetUtcTimestamp - now.getTime())
    const formatted = formatter.format(nextDate)

    return { nextDate, delayMs, formatted, jitterMinutes }
}

function runRewardsBot(): Promise<number> {
    return new Promise((resolve) => {
        if (isShuttingDown) {
            resolve(-1)
            return
        }

        isJobRunning = true
        log('SCHEDULER', '=== Launching Microsoft Rewards Bot Session ===')

        const entrypoint = path.join(__dirname, 'index.js')
        const child = fork(entrypoint, process.argv.slice(2), {
            stdio: 'inherit',
            env: {
                ...process.env,
                FORCE_HEADLESS: process.env.FORCE_HEADLESS ?? '1'
            }
        })

        activeChild = child

        child.on('exit', (code, signal) => {
            activeChild = null
            isJobRunning = false
            if (signal) {
                log('SCHEDULER', `Session ended with signal ${signal}`)
                resolve(-1)
            } else {
                log('SCHEDULER', `Session completed with exit code ${code ?? 0}`)
                resolve(code ?? 0)
            }
        })

        child.on('error', (err) => {
            activeChild = null
            isJobRunning = false
            log('SCHEDULER', `Session child process error: ${err.message}`)
            resolve(1)
        })
    })
}

function formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000)
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    return `${hours}h ${minutes}m ${seconds}s`
}

function scheduleNextRun(): void {
    const calc = computeNextRun(TIMEZONE, TARGET_HOUR, TARGET_MINUTE, JITTER_MAX_MINUTES)
    nextRunTimestamp = calc.nextDate.getTime()

    log(
        'SCHEDULER',
        `Next daily run scheduled: ${calc.formatted} (${TIMEZONE}) | in ${formatDuration(calc.delayMs)} | jitter: +${calc.jitterMinutes}m`
    )
}

async function checkTick(): Promise<void> {
    if (isShuttingDown || isJobRunning) return

    const now = Date.now()
    if (nextRunTimestamp > 0 && now >= nextRunTimestamp) {
        log('SCHEDULER', 'Scheduled trigger time reached. Starting daily rewards collection!')
        nextRunTimestamp = 0
        await runRewardsBot()
        scheduleNextRun()
        return
    }

    // Heartbeat every 2 hours
    const currentHour = new Date().getHours()
    if (currentHour !== lastHeartbeatHour && currentHour % 2 === 0) {
        lastHeartbeatHour = currentHour
        const remaining = Math.max(0, nextRunTimestamp - now)
        log('HEARTBEAT', `Scheduler daemon is active. Next run in ${formatDuration(remaining)}`)
    }
}

async function startDaemon(): Promise<void> {
    log('SCHEDULER', `Initializing Microsoft Rewards Scheduler Daemon`)
    log(
        'SCHEDULER',
        `Config: Target=${String(TARGET_HOUR).padStart(2, '0')}:${String(TARGET_MINUTE).padStart(2, '0')} | Timezone=${TIMEZONE} | MaxJitter=${JITTER_MAX_MINUTES}min`
    )

    if (RUN_ON_START) {
        log('SCHEDULER', 'Immediate run requested via RUN_ON_START / --now')
        await runRewardsBot()
    }

    scheduleNextRun()

    // Resilient tick loop every 30 seconds
    setInterval(() => {
        void checkTick()
    }, 30000)
}

function setupProcessHandlers(): void {
    const shutdown = (signal: string) => {
        if (isShuttingDown) return
        isShuttingDown = true
        log('SCHEDULER', `Received ${signal}. Shutting down scheduler daemon...`)

        if (activeChild) {
            log('SCHEDULER', `Stopping active bot child process...`)
            activeChild.kill('SIGTERM')
        }

        setTimeout(() => {
            process.exit(0)
        }, 1500).unref()
    }

    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
}

setupProcessHandlers()
void startDaemon()
