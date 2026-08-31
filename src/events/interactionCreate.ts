import { Collection, Events, MessageFlags, type Interaction } from "discord.js";
import type  { Command } from "../types/command.ts";

export default {
    name: Events.InteractionCreate,
    async execute(interaction: Interaction) {
        // the interaction type is genuinely unknown at first — but by the time command.execute(interaction) is called, it's already been narrowed down to ChatInputCommandInteraction by the isChatInputCommand() check, so the type of interaction in the execute function of each command is correct and safe to use.
        if (!interaction.isChatInputCommand()) return;
        const command: Command | undefined = interaction.client.commands.get(interaction.commandName);
        if (!command) {
            console.error(`No command matching ${interaction.commandName} was found.`);
            return;
        }
        
        // Cooldown logic before execute
        const { cooldowns } = interaction.client;
        const now = Date.now();
        // Get the timestamps for the command, or create a new collection if it doesn't exist; uses ensure() over get() for Typescript checks
        const timestamps = cooldowns.ensure(command.data.name, () => new Collection());
        // Even though you .set() the value on the line above if it's missing, TypeScript's Collection/Map types don't track "you just ensured this key exists" across separate statements — .get() always returns V | undefined regardless of what happened before it.
        // discord.js's Collection class actually has a purpose-built method for exactly this pattern: .ensure(). It gets a value if present, or sets and returns a default if not — atomically, in one call, and with a return type that's correctly non-optional
        // This replaces your if (!cooldowns.has(...)) { cooldowns.set(...) } block entirely — one line does both jobs, and timestamps is now properly typed as Collection<string, number> (no undefined).
        //        const { cooldowns } = interaction.client;
        // if (!cooldowns.has(command.data.name)) {
        //     cooldowns.set(command.data.name, new Collection());
        // }
        // const now = Date.now();
        // const timestamps = cooldowns.get(command.data.name);
        const defaultCooldownDuration = 3;
        const cooldownAmount = (command.cooldown ?? defaultCooldownDuration) * 1_000;

        // Check if the user has a timestamp for this command and if the cooldown has expired
        const userTimestamp = timestamps.get(interaction.user.id);
        if (userTimestamp !== undefined) {
            const expirationTime = userTimestamp + cooldownAmount;
            if (now < expirationTime) {
                const expiredTimestamp = Math.round(expirationTime / 1_000);
                return interaction.reply({
                    content: `Please wait, you are on a cooldown for \`${command.data.name}\`. You can use it again <t:${expiredTimestamp}:R>.`,
                    flags: MessageFlags.Ephemeral,
                });
            }
        }

        //calling .has() doesn't narrow the type of a separate .get() call, even immediately after — TypeScript doesn't know the two calls are related. The cleanest fix is to store the result once and check that instead of calling .has() then .get() separately
        // if (timestamps.has(interaction.user.id)) {
        //     const expirationTime = timestamps.get(interaction.user.id) + cooldownAmount;
	    //     if (now < expirationTime) {
		//         const expiredTimestamp = Math.round(expirationTime / 1_000);
		//         return interaction.reply({
		// 	        content: `Please wait, you are on a cooldown for \`${command.data.name}\`. You can use it again <t:${expiredTimestamp}:R>.`,
		// 	        flags: MessageFlags.Ephemeral,
		//         });
	    //     }
        // }

        timestamps.set(interaction.user.id, now);
        setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);

        // Execute logic
        try {
            await command.execute(interaction);
        } catch (error) {
            console.error(error);
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({
                    content: 'There was an error while executing this command!',
                    flags: MessageFlags.Ephemeral,
                });
            } else {
                await interaction.reply({
                    content: 'There was an error while executing this command!',
                    flags: MessageFlags.Ephemeral,
                });
            }
        }

    },
};