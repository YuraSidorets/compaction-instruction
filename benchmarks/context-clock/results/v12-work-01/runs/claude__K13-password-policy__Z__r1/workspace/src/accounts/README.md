# Password policy

`src/accounts/password-policy.mjs` exports `checkPassword(password, context)`.

`password` is a string. `context` is `{ username }`, and `username` can be missing.

The function returns the codes of the broken rules as an array, sorted in alphabetical order. It returns an empty array if the password breaks no rule. The codes are:

- `"too-short"`: the password has fewer characters than the minimum password length.
- `"too-long"`: the password has more characters than the maximum password length.
- `"needs-digit"`: a digit is required and the password has no digit (0 to 9).
- `"needs-upper"`: an uppercase letter is required and the password has no letter from A to Z.
- `"needs-symbol"`: a symbol is required and the password has no character that is not a letter from A to Z or a to z and not a digit.
- `"contains-username"`: the username rule is on, the username has 3 or more characters, and the password contains the username. Case does not matter.
- `"banned-word"`: the password contains a word from the list of banned words. Case does not matter.

The security team sets the values of these requirements.
