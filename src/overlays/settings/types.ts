import type { IconName } from '../../ui/icons';
import type { SettingsRow } from './rows';

export interface SubsectionDef {
    title: string;
    rows: SettingsRow[];
}

export interface SectionDef {
    id: string;
    title: string;
    icon: IconName;
    subsections: SubsectionDef[];
}
