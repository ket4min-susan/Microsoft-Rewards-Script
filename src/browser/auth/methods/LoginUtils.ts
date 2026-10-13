import type { Page } from 'patchright'
import readline from 'readline'

export interface PromptOptions {
    question: string
    timeoutSeconds?: number
    validate?: (input: string) => boolean
    transform?: (input: string) => string
}

import fs from 'node:fs'
import path from 'node:path'

export function canPromptForInput(): boolean {
    return true
}

export function promptInput(options: PromptOptions): Promise<string | null> {
    const { question, timeoutSeconds = 60, validate, transform } = options

    return new Promise(resolve => {
        let resolved = false
        let filePollInterval: NodeJS.Timeout | null = null
        let rl: readline.Interface | null = null
        const codeFilePath = path.resolve(process.cwd(), 'code.txt')

        const cleanup = (result: string | null) => {
            if (resolved) return
            resolved = true
            clearTimeout(timer)
            if (filePollInterval) clearInterval(filePollInterval)
            if (rl) rl.close()
            resolve(result)
        }

        const timer = setTimeout(() => cleanup(null), timeoutSeconds * 1000)

        filePollInterval = setInterval(() => {
            try {
                if (fs.existsSync(codeFilePath)) {
                    let content = fs.readFileSync(codeFilePath, 'utf8').trim()
                    if (transform) content = transform(content)
                    if (!validate || validate(content)) {
                        try {
                            fs.unlinkSync(codeFilePath)
                        } catch {}
                        cleanup(content)
                    }
                }
            } catch {}
        }, 1000)

        if (process.stdin.isTTY) {
            rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            })
            rl.question(question, answer => {
                let value = answer.trim()
                if (transform) value = transform(value)

                if (validate && !validate(value)) {
                    cleanup(null)
                    return
                }

                cleanup(value)
            })
        }
    })
}

export async function getSubtitleMessage(page: Page): Promise<string | null> {
    const message = await page
        .waitForSelector('[data-testid="subtitle"], div#oneTimeCodeDescription, [data-testid="description"]', {
            state: 'visible',
            timeout: 1000
        })
        .catch(() => null)

    if (!message) return null

    const text = await message.innerText()
    return text.trim()
}

export async function getErrorMessage(page: Page): Promise<string | null> {
    const errorAlert = await page
        .waitForSelector('div[role="alert"]', { state: 'visible', timeout: 1000 })
        .catch(() => null)

    if (!errorAlert) return null

    const text = await errorAlert.innerText()
    return text.trim()
}
