// A estrutura final do wizard de sprint é uma FinalSprint isolada — mesma forma
// que o wizard de projeto já usa dentro de FinalEpic. Reaproveitada como está,
// sem tipo/validação novos.
export type { FinalSprint, FinalTask } from '../planning/structure-schema.js'
export { validateFinalSprint } from '../planning/structure-schema.js'
