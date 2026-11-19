import { Collection, Events, MessageFlags, type Interaction } from "discord.js";
import type  { Command } from "../types/command.ts";

export default {
    name: Events.InteractionCreate,
    async execute(interaction: Interaction) {
        if (!interaction.isChatInputCommand()) return;
        const command: Command | undefined = interaction.client.commands.get(interaction.commandName);
        if (!command) {
            console.error(`No command matching ${interaction.commandName} was found.`);
            return;
        }
        
        const { cooldowns } = interaction.client;
        const now = Date.now();
        const timestamps = cooldowns.ensure(command.data.name, () => new Collection());
        const defaultCooldownDuration = 3;
        const cooldownAmount = (command.cooldown ?? defaultCooldownDuration) * 1_000;

        const userTimestamp = timestamps.get(interaction.user.id);
        if (userTimestamp !== undefined) {
            const expirationTime = userTimestamp + cooldownAmount;
            if (now < expirationTime) {
                const expiredTimestamp = Math.round(expirationTime / 1_000);
                await interaction.reply({
                    content: `Please wait, you are on a cooldown for \`${command.data.name}\`. You can use it again <t:${expiredTimestamp}:R>.`,
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }
        }

        timestamps.set(interaction.user.id, now);
        setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);

        try {
            await command.execute(interaction);
        } catch (error) {
            console.error(error);
            // The fallback reply can fail too (40060, already acknowledged, when the
            // command's own reply landed right at the token's expiry). Unhandled, that
            // rejection crashed the bot in production, so it is caught and logged.
            try {
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
            } catch (followUpError) {
                console.error('Failed to notify the user of the earlier error:', followUpError);
            }
        }
    },
};