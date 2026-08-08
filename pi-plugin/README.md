# Pi Context plugin

Scaffold for a project-local Pi extension. Pi supports TypeScript extension modules and can load this file directly during development:

```sh
pi --extension ./src/index.ts
```

The current `/pi-context` command only confirms that the scaffold is loaded. It deliberately does not start a listener or manipulate prompt input until the supported Pi input-interception API has been validated.
