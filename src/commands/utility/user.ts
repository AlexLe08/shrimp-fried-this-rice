import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";

export default {
	data: new SlashCommandBuilder().setName('user').setDescription('Provides information about the user.'),
	async execute(interaction: ChatInputCommandInteraction) {
		// interaction.user is the object representing the User who ran the command
		// interaction.member is the GuildMember object, which represents the user in the specific guild

        if (!interaction.inCachedGuild()) {
            // return interaction.reply(...) makes it look like the function's return value matters (as if something downstream might use the resolved Message), when in reality you're just using return as a control-flow early-exit. Separating await interaction.reply(...) from return; makes the intent explicit — "send this reply, then stop running" — rather than implying a value is being handed back to a caller that never actually uses it.
            await interaction.reply("This command can only be used in a server.");
            return;
        }

		await interaction.reply(
			`This command was run by ${interaction.user.username}, who joined on ${interaction.member.joinedAt}.`,
		);
	},
};