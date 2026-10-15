import type { JSX as ReactJSX } from 'react'
import type { Bridge } from '../../preload'

declare global {
  interface Window {
    bridge: Bridge
  }
  namespace JSX {
    type Element = ReactJSX.Element
  }
}
