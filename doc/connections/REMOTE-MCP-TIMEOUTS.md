# Remote MCP call timeouts

A remote MCP connection can set `config.toolTimeoutMs` to a number of milliseconds.
For example, `{"toolTimeoutMs": 25000}` gives each tool call 25 seconds.
The default is 10 seconds.
The gateway rounds the value down and clamps it between 1 and 60,000 milliseconds.
Non-numeric and non-finite values use the default.
An explicit request `timeoutMs` takes precedence over the connection setting.
Existing provider-specific budgets, such as Railway command budgets, retain their precedence.
Approved background actions retain their existing execution budget.

When `config.mcpSessionRequired` is true, session setup has a separate 10-second budget.
This budget covers `initialize` and `notifications/initialized` together.
The tool-call budget starts after setup completes.
Cached sessions do not require another setup exchange.
The tool-call budget includes response body consumption.
A timeout does not prove that an upstream action stopped.
The gateway does not automatically repeat the action.

This setting applies to remote MCP calls through the tool gateway.
It does not change local standard-input/output connections or provider REST calls.
Changing the gateway code does not change existing connection settings.
An operator must set the connection value separately.
