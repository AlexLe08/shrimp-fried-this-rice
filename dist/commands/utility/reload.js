import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL, } from 'node:url';
// The __dirname variable is not available in ES modules, so we need to use the fileURLToPath() function from the node:url module to get the current file's path and then use path.dirname() to get the directory name.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export default {
    data: new SlashCommandBuilder()
        .setName('reload')
        .setDescription('Reloads a command.')
        .addStringOption(option => option.setName('command')
        .setDescription('The command to reload.')
        .setRequired(true)),
    async execute(interaction) {
        if (!interaction.isChatInputCommand())
            return;
        const commandName = interaction.options.getString('command', true).toLowerCase();
        const command = interaction.client.commands.get(commandName);
        if (!command) {
            return interaction.reply({
                content: `There is no command with name \`${commandName}\`!`,
                flags: MessageFlags.Ephemeral,
            });
        }
        // at runtime, this code executes as compiled .js in dist/, so importing ./${commandName}.ts will fail to resolve. It needs .js, and per Node's ESM rules should be a proper file URL built with pathToFileURL, not a bare relative path.
        //const commandPath = path.join(__dirname, `${commandName}.js`);
        // This is a leftover from the CommonJS version of the discord.js guide. Under ESM there's no require at all, so this line will throw at runtime. Node's ESM dynamic import() also caches modules by resolved URL, so re-importing the same path returns the cached version rather than freshly reloading it — you need a cache-busting trick instead, typically a dummy query string appended to the URL
        // delete require.cache[require.resolve(`./${commandName}.ts`)];
        // since reload.ts compiles to dist/commands/utility/reload.js, going up one level (..) lands at dist/commands/, the parent of all category folders. This assumes reload.ts itself stays inside a category folder
        const commandsRoot = path.join(__dirname, '..');
        const categories = fs.readdirSync(commandsRoot);
        let commandPath;
        // Look for the command file in each category folder under dist/commands/. If the command file is found, set commandPath to its path and break the loop. If not found, commandPath remains undefined.
        for (const category of categories) {
            const candidate = path.join(commandsRoot, category, `${commandName}.ts`);
            if (fs.existsSync(candidate)) {
                commandPath = candidate;
                break;
            }
        }
        if (!commandPath) {
            return interaction.reply({
                content: `Could not find a command file for \`${commandName}\`.`,
                flags: MessageFlags.Ephemeral,
            });
        }
        // Dynamically import the command module using the path to the file and a query parameter to force a reload
        // const newCommandModule = await import(`${pathToFileURL(commandPath).href}?update=${Date.now()}`) as { default: Command };
        try {
            // Dynamically import the command module using the path to the file and a query parameter to force a reload
            const newCommandModule = await import(`${pathToFileURL(commandPath).href}?update=${Date.now()}`);
            interaction.client.commands.set(commandName, newCommandModule.default);
            await interaction.reply({
                content: `Command \`${commandName}\` was reloaded!`,
                flags: MessageFlags.Ephemeral // Ephemeral means the message will only be visible to the user who triggered the command
            });
        }
        catch (error) {
            console.error(error);
            // If the error is an instance of Error, we can access its message property. Otherwise, we convert the error to a string.
            // Under strict mode, caught errors are typed unknown, not any (this is the useUnknownInCatchVariables behavior, on by default with strict: true). Accessing .message directly will error. Needs a narrowing check.
            const message = error instanceof Error ? error.message : String(error);
            await interaction.reply({
                content: `There was an error while reloading a command \`${commandName}\`:\n\`${message}\``,
                flags: MessageFlags.Ephemeral // this pattern replaces the older ephemeral: true API
            });
        }
    },
};
//# sourceMappingURL=reload.js.map