import sharp from 'sharp'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const svg = readFileSync(join(root, 'resources', 'icon.svg'))

// Update the SVG background to match new dark theme (#000000 instead of #1a1b2e)
const updatedSvg = Buffer.from(
  svg.toString().replace(/#1a1b2e|#0e0f1a/g, '#000000')
)

const targets = [
  { path: 'mobile/assets/icon.png', size: 1024 },
  { path: 'mobile/assets/adaptive-icon.png', size: 1024 },
  { path: 'mobile/assets/splash-icon.png', size: 1024 },
  { path: 'mobile/assets/favicon.png', size: 48 },
]

for (const { path, size } of targets) {
  await sharp(updatedSvg)
    .resize(size, size)
    .png()
    .toFile(join(root, path))
  console.log(`Generated ${path} (${size}x${size})`)
}

console.log('Done!')
