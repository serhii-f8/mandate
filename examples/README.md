# Example configuration

`examples/config/` is a complete, commented configuration for the product. It loads with the
shipped presets (`@aiops/magento2-catalog`, `@aiops/gitea-issues`) and is validated in CI by
`apps/api/test/e2e/example-config.e2e.test.ts` (CFG-1, CFG-2).

Check it, or a copy you edited:

```
pnpm aiops validate examples/config --preset-dir presets
```

Copy the directory, replace every `.invalid` host with your own system, enter the credentials on
the trusted credential page (the files name credentials only, never hold them; CFG-5), and replace
the illustrative MCP tool pin with the one `aiops config diff` reports for your upstream.
