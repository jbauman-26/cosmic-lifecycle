// Names shared by the warehouse and the query check, kept free of anything that starts a process.
/** The schema a source loads into: gorgias is src_gorgias, judge-me is src_judge_me. */
export const datasetFor = (slug) => `src_${slug.replace(/-/g, '_')}`;
/**
 * The source a schema belongs to, or undefined for the CLI's own tables. A slug holds letters,
 * numbers and dashes only, so the schema name turns back into it exactly. dlt keeps a
 * <schema>_staging copy for merges, which belongs to the same source.
 */
export function sourceOfSchema(schema) {
    const s = schema.toLowerCase().replace(/_staging$/, '');
    return s.startsWith('src_') ? s.slice(4).replace(/_/g, '-') : undefined;
}
export const isWarehouseSchema = (schema) => /^src_/i.test(schema);
