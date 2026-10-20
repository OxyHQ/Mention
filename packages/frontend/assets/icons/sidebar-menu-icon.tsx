import { Path } from 'react-native-svg';
import { IconSvg } from '@/assets/icons/IconSvg';

export function SidebarMenuIcon({
  width = 24,
  height = 24,
  fill = 'currentColor',
}: {
  width?: number;
  height?: number;
  fill?: string;
}) {
  return (
    <IconSvg viewBox="0 0 24 24" width={width} height={height}>
      <Path
        d="M19.25 16C19.9404 16 20.5 16.5596 20.5 17.25C20.5 17.9404 19.9404 18.5 19.25 18.5H4.25C3.55964 18.5 3 17.9404 3 17.25C3 16.5596 3.55964 16 4.25 16H19.25Z"
        fill={fill}
      />
      <Path
        d="M19.25 6C19.9404 6 20.5 6.55964 20.5 7.25C20.5 7.94036 19.9404 8.5 19.25 8.5H4.25C3.55964 8.5 3 7.94036 3 7.25C3 6.55964 3.55964 6 4.25 6H19.25Z"
        fill={fill}
      />
    </IconSvg>
  );
}
