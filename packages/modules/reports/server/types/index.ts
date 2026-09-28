import type { ReportTypeId } from '../api-types.js'
import type { ReportTypeDef } from './common.js'
import { sprintReport } from './sprint.js'

/** Tipos de relatório do módulo — acrescentar um tipo é acrescentar aqui. */
export const REPORT_TYPES: ReadonlyMap<ReportTypeId, ReportTypeDef> = new Map([
  ['sprint', sprintReport],
])
