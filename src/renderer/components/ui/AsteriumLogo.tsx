import type { CSSProperties } from 'react';
import { ASTERIUM_LOGO_DATA_URL } from '../../assets/asteriumLogoData';

const logoMaskStyle = {
  WebkitMaskImage: `url("${ASTERIUM_LOGO_DATA_URL}")`,
  maskImage: `url("${ASTERIUM_LOGO_DATA_URL}")`,
} as CSSProperties;

export function AsteriumLogo({ className = '' }: { className?: string }) {
  return <span className={`asterium-logo ${className}`.trim()} style={logoMaskStyle} aria-hidden="true" />;
}
