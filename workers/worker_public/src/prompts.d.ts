// Prompt data files (../prompts/*.md) are bundled by wrangler's Text
// module rule and imported as strings.
declare module "*.md" {
  const content: string;
  export default content;
}
